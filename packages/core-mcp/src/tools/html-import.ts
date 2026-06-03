/**
 * HTML import tools — convert static HTML into a FigCraft create_frame payload.
 *
 * This is intentionally conservative: it preserves semantic structure,
 * readable typography, basic colors, spacing, images, inputs, and buttons
 * without trying to implement a full browser layout engine.
 */

import { lookup } from 'node:dns/promises';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, delimiter, extname, isAbsolute, normalize, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from '../bridge.js';
import { jsonResponse } from './response-helpers.js';

const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_WIDTH = 1440;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 250;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const IGNORED_TAGS = new Set(['script', 'style', 'template', 'noscript', 'head', 'meta', 'link']);
const TEXT_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'button',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'label',
  'p',
  'small',
  'span',
  'strong',
  'time',
]);
const BLOCK_TAGS = new Set([
  'article',
  'aside',
  'body',
  'div',
  'fieldset',
  'footer',
  'form',
  'header',
  'main',
  'nav',
  'section',
]);

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000FF',
  currentcolor: '#111827',
  gray: '#808080',
  green: '#008000',
  grey: '#808080',
  red: '#FF0000',
  transparent: '#FFFFFF00',
  white: '#FFFFFF',
};
const HTML_FILE_EXTENSIONS = new Set(['.html', '.htm', '.xhtml']);
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);

type SourceKind = 'html' | 'file' | 'url';

interface HtmlImportSource {
  kind: SourceKind;
  html: string;
  byteLength: number;
  filePath?: string;
  url?: string;
  title?: string;
}

interface HtmlTextNode {
  kind: 'text';
  text: string;
}

interface HtmlElementNode {
  kind: 'element';
  tagName: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  selfClosing?: boolean;
}

type HtmlNode = HtmlTextNode | HtmlElementNode;

export interface HtmlImportOptions {
  name?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  parentId?: string;
  baseUrl?: string;
  maxDepth?: number;
  maxNodes?: number;
}

interface ConvertContext {
  baseUrl?: string;
  maxDepth: number;
  maxNodes: number;
  nodeCount: number;
  warnings: string[];
}

export interface HtmlImportPayload {
  name: string;
  role: string;
  width: number;
  height?: number;
  x?: number;
  y?: number;
  parentId?: string;
  layoutMode: 'VERTICAL';
  layoutSizingHorizontal: 'FIXED';
  layoutSizingVertical: 'FIXED';
  fill: string;
  padding: number;
  itemSpacing: number;
  children: Record<string, unknown>[];
}

export class HtmlImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HtmlImportError';
  }
}

function htmlImportError(code: string, message: string): HtmlImportError {
  return new HtmlImportError(code, message);
}

function getMaxBytes(): number {
  const raw = process.env.FIGCRAFT_HTML_IMPORT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_BYTES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
}

function getFetchTimeoutMs(): number {
  const raw = process.env.FIGCRAFT_HTML_IMPORT_FETCH_TIMEOUT_MS;
  if (!raw) return DEFAULT_FETCH_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) return DEFAULT_FETCH_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_FETCH_TIMEOUT_MS;
}

function parseAllowedRoots(rootsEnv = process.env.FIGCRAFT_HTML_IMPORT_ROOTS): string[] {
  if (rootsEnv?.trim() === '*') return [];
  if (!rootsEnv?.trim()) return [normalize(process.cwd())];
  return rootsEnv
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => normalize(entry));
}

function isWithinRoot(filePath: string, root: string): boolean {
  const normalizedRoot = normalize(root);
  if (filePath === normalizedRoot) return true;
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return filePath.startsWith(rootWithSep);
}

async function resolveAllowedRoots(rootsEnv?: string): Promise<string[]> {
  const roots = parseAllowedRoots(rootsEnv);
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(await realpath(root));
    } catch {
      resolved.push(root);
    }
  }
  return resolved;
}

async function assertPathAllowed(filePath: string, rootsEnv?: string): Promise<void> {
  const roots = await resolveAllowedRoots(rootsEnv);
  if (roots.length === 0) return;
  if (!roots.some((root) => isWithinRoot(filePath, root))) {
    throw htmlImportError('PATH_NOT_ALLOWED', `HTML path is outside FIGCRAFT_HTML_IMPORT_ROOTS: ${filePath}`);
  }
}

function assertHtmlFilePath(filePath: string): void {
  const ext = extname(filePath).toLowerCase();
  if (!HTML_FILE_EXTENSIONS.has(ext)) {
    throw htmlImportError('INVALID_PATH', `HTML filePath must end in .html, .htm, or .xhtml: ${filePath}`);
  }
}

function looksLikeHtml(html: string): boolean {
  return (
    /<!doctype\s+html\b/i.test(html) ||
    /<\/?(html|body|main|section|article|header|footer|nav|div|p|h[1-6]|span|button|form|input|textarea|select|img|svg)\b/i.test(
      html,
    )
  );
}

function assertLooksLikeHtml(html: string, label: string): void {
  if (!looksLikeHtml(html)) {
    throw htmlImportError('INVALID_HTML', `${label} does not look like HTML.`);
  }
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return undefined;
  return decodeHtml(match[1]).replace(/\s+/g, ' ').trim() || undefined;
}

function extractBody(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return match ? match[1] : html;
}

function stripIgnoredRawContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[\s\S]*?>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<template\b[\s\S]*?<\/template>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '');
  const version = isIP(normalized);
  if (version === 4) return isPrivateIPv4(normalized);
  if (version === 6) return isPrivateIPv6(normalized);
  return false;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

async function assertUrlAllowed(url: URL): Promise<void> {
  if (process.env.FIGCRAFT_HTML_IMPORT_ALLOW_PRIVATE_URLS === 'true') return;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isLocalHostname(hostname) || isPrivateAddress(hostname)) {
    throw htmlImportError(
      'PRIVATE_URL_BLOCKED',
      'Private, loopback, and link-local URLs are blocked by default. Set FIGCRAFT_HTML_IMPORT_ALLOW_PRIVATE_URLS=true to allow local/private imports.',
    );
  }
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw htmlImportError(
        'PRIVATE_URL_BLOCKED',
        'URL resolves to a private, loopback, or link-local address. Set FIGCRAFT_HTML_IMPORT_ALLOW_PRIVATE_URLS=true to allow it.',
      );
    }
  } catch (err) {
    if (err instanceof HtmlImportError) throw err;
    throw htmlImportError(
      'URL_DNS_FAILED',
      `DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function assertHtmlContentType(response: Response): void {
  const raw = response.headers.get('content-type');
  if (!raw) return;
  const type = raw.split(';', 1)[0]?.trim().toLowerCase();
  if (type && !HTML_CONTENT_TYPES.has(type)) {
    throw htmlImportError(
      'UNSUPPORTED_CONTENT_TYPE',
      `URL returned ${raw}; expected text/html or application/xhtml+xml.`,
    );
  }
}

async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<{ html: string; byteLength: number }> {
  const rawLength = response.headers.get('content-length');
  if (rawLength && /^\d+$/.test(rawLength) && Number(rawLength) > maxBytes) {
    throw htmlImportError(
      'HTML_TOO_LARGE',
      `Fetched HTML declares ${rawLength} bytes, exceeding the ${maxBytes} byte limit.`,
    );
  }

  if (!response.body) {
    const html = await response.text();
    const byteLength = Buffer.byteLength(html, 'utf8');
    if (byteLength > maxBytes) {
      throw htmlImportError(
        'HTML_TOO_LARGE',
        `Fetched HTML is ${byteLength} bytes, exceeding the ${maxBytes} byte limit.`,
      );
    }
    return { html, byteLength };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw htmlImportError(
          'HTML_TOO_LARGE',
          `Fetched HTML exceeds the ${maxBytes} byte limit and was stopped early.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { html: Buffer.concat(chunks).toString('utf8'), byteLength };
}

async function fetchHtmlDocument(
  initialUrl: URL,
  maxBytes: number,
): Promise<{ html: string; byteLength: number; url: string }> {
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    await assertUrlAllowed(current);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), getFetchTimeoutMs());
    try {
      const response = await fetch(current, {
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw htmlImportError(
            'URL_FETCH_FAILED',
            `Redirect from ${current.toString()} did not include a Location header.`,
          );
        }
        current = new URL(location, current);
        if (current.protocol !== 'http:' && current.protocol !== 'https:') {
          throw htmlImportError('INVALID_URL', 'Only http:// and https:// redirects are supported.');
        }
        continue;
      }

      if (!response.ok) {
        throw htmlImportError('URL_FETCH_FAILED', `Fetch failed with ${response.status} ${response.statusText}`);
      }
      assertHtmlContentType(response);
      const result = await readResponseTextLimited(response, maxBytes);
      assertLooksLikeHtml(result.html, `Fetched URL ${current.toString()}`);
      return { ...result, url: current.toString() };
    } catch (err) {
      if (err instanceof HtmlImportError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw htmlImportError(
          'URL_FETCH_TIMEOUT',
          `Fetch timed out after ${getFetchTimeoutMs()}ms: ${current.toString()}`,
        );
      }
      throw htmlImportError('URL_FETCH_FAILED', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw htmlImportError('TOO_MANY_REDIRECTS', `URL exceeded ${MAX_REDIRECTS} redirects.`);
}

export async function loadHtmlImportSource(params: {
  html?: string;
  filePath?: string;
  url?: string;
  maxBytes?: number;
  rootsEnv?: string;
}): Promise<HtmlImportSource> {
  const provided = [params.html != null, params.filePath != null, params.url != null].filter(Boolean).length;
  if (provided !== 1) {
    throw htmlImportError('INVALID_SOURCE', 'Provide exactly one of html, filePath, or url.');
  }

  const maxBytes = params.maxBytes ?? getMaxBytes();

  if (params.html != null) {
    const byteLength = Buffer.byteLength(params.html, 'utf8');
    if (byteLength > maxBytes) {
      throw htmlImportError('HTML_TOO_LARGE', `HTML is ${byteLength} bytes, exceeding the ${maxBytes} byte limit.`);
    }
    return { kind: 'html', html: params.html, byteLength, title: extractTitle(params.html) };
  }

  if (params.filePath != null) {
    if (!isAbsolute(params.filePath)) {
      throw htmlImportError('INVALID_PATH', `HTML filePath must be absolute: ${params.filePath}`);
    }
    assertHtmlFilePath(params.filePath);

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(params.filePath);
    } catch {
      throw htmlImportError('INVALID_PATH', `HTML filePath does not exist: ${params.filePath}`);
    }

    await assertPathAllowed(resolvedPath, params.rootsEnv);
    assertHtmlFilePath(resolvedPath);
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) {
      throw htmlImportError('INVALID_PATH', `HTML filePath is not a file: ${resolvedPath}`);
    }
    if (fileStat.size > maxBytes) {
      throw htmlImportError(
        'HTML_TOO_LARGE',
        `HTML file is ${fileStat.size} bytes, exceeding the ${maxBytes} byte limit.`,
      );
    }
    const html = await readFile(resolvedPath, 'utf8');
    assertLooksLikeHtml(html, `HTML file ${resolvedPath}`);
    return {
      kind: 'file',
      html,
      filePath: resolvedPath,
      byteLength: Buffer.byteLength(html),
      title: extractTitle(html),
    };
  }

  const url = params.url as string;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw htmlImportError('INVALID_URL', `Invalid URL: ${url}`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw htmlImportError('INVALID_URL', 'Only http:// and https:// URLs are supported.');
  }

  const fetched = await fetchHtmlDocument(parsedUrl, maxBytes);
  return {
    kind: 'url',
    html: fetched.html,
    url: fetched.url,
    byteLength: fetched.byteLength,
    title: extractTitle(fetched.html),
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrText = raw.replace(/^<\/?\s*[\w:-]+/, '').replace(/\/?\s*>$/, '');
  const attrRe = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of attrText.matchAll(attrRe)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = decodeHtml(value);
  }
  return attrs;
}

export function parseHtml(html: string): HtmlElementNode {
  const root: HtmlElementNode = { kind: 'element', tagName: 'root', attrs: {}, children: [] };
  const stack: HtmlElementNode[] = [root];
  const tokenRe = /<\/?[A-Za-z][^>]*>/g;
  let lastIndex = 0;
  const body = stripIgnoredRawContent(extractBody(html));

  for (const match of body.matchAll(tokenRe)) {
    const token = match[0];
    const index = match.index ?? 0;
    const text = body.slice(lastIndex, index);
    appendText(stack[stack.length - 1], text);

    const tagMatch = token.match(/^<\/?\s*([A-Za-z][\w:-]*)/);
    if (!tagMatch) {
      lastIndex = index + token.length;
      continue;
    }
    const tagName = tagMatch[1].toLowerCase();
    if (IGNORED_TAGS.has(tagName)) {
      lastIndex = index + token.length;
      continue;
    }

    if (token.startsWith('</')) {
      closeElement(stack, tagName);
    } else {
      const selfClosing = token.endsWith('/>') || VOID_TAGS.has(tagName);
      const node: HtmlElementNode = {
        kind: 'element',
        tagName,
        attrs: parseAttributes(token),
        children: [],
        selfClosing,
      };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
    lastIndex = index + token.length;
  }

  appendText(stack[stack.length - 1], body.slice(lastIndex));
  return root;
}

function appendText(parent: HtmlElementNode, rawText: string): void {
  const text = decodeHtml(rawText).replace(/\s+/g, ' ').trim();
  if (!text) return;
  parent.children.push({ kind: 'text', text });
}

function closeElement(stack: HtmlElementNode[], tagName: string): void {
  for (let i = stack.length - 1; i > 0; i--) {
    if (stack[i].tagName === tagName) {
      stack.length = i;
      return;
    }
  }
}

function parseStyle(style?: string): Record<string, string> {
  if (!style) return {};
  const result: Record<string, string> = {};
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const prop = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (prop && value) result[prop] = value;
  }
  return result;
}

function parsePx(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const number = Number(match[0]);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : undefined;
}

function parseSpacing(style: Record<string, string>, prop: 'padding' | 'margin'): number | undefined {
  return (
    parsePx(style[prop]) ??
    parsePx(style[`${prop}-top`]) ??
    parsePx(style[`${prop}-right`]) ??
    parsePx(style[`${prop}-bottom`]) ??
    parsePx(style[`${prop}-left`])
  );
}

function normalizeColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const input = value.trim().toLowerCase();
  if (input.startsWith('linear-gradient') || input.startsWith('radial-gradient')) return undefined;
  const hex = input.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const raw = hex[1];
    if (raw.length === 3 || raw.length === 4) {
      if (raw.length === 4 && raw[3].toLowerCase() !== 'f') return undefined;
      return `#${raw
        .slice(0, 3)
        .split('')
        .map((c) => c + c)
        .join('')
        .toUpperCase()}`;
    }
    if (raw.length === 8 && raw.slice(6, 8).toLowerCase() !== 'ff') return undefined;
    return `#${raw.slice(0, 6).toUpperCase()}`;
  }
  const rgb = input.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(',').map((part) => Number.parseFloat(part.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) {
      if (parts.length >= 4 && Number.isFinite(parts[3]) && parts[3] < 1) return undefined;
      return `#${parts
        .slice(0, 3)
        .map((part) =>
          Math.max(0, Math.min(255, Math.round(part)))
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
        .toUpperCase()}`;
    }
  }
  return NAMED_COLORS[input];
}

function fontStyleFromWeight(weight: string | undefined, forceBold: boolean): string | undefined {
  if (forceBold) return 'Bold';
  if (!weight) return undefined;
  const normalized = weight.trim().toLowerCase();
  if (normalized === 'bold' || normalized === 'bolder') return 'Bold';
  if (normalized === 'normal' || normalized === 'lighter') return undefined;
  const numeric = parsePx(weight);
  if (numeric == null) return undefined;
  if (numeric >= 900) return 'Black';
  if (numeric >= 800) return 'ExtraBold';
  if (numeric >= 700) return 'Bold';
  if (numeric >= 600) return 'SemiBold';
  if (numeric >= 500) return 'Medium';
  if (numeric <= 300) return 'Light';
  return undefined;
}

function textContent(node: HtmlElementNode): string {
  const parts: string[] = [];
  const walk = (child: HtmlNode): void => {
    if (child.kind === 'text') {
      parts.push(child.text);
      return;
    }
    for (const grandchild of child.children) walk(grandchild);
  };
  for (const child of node.children) walk(child);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function directTextOnly(node: HtmlElementNode): boolean {
  return node.children.length > 0 && node.children.every((child) => child.kind === 'text');
}

function nodeName(node: HtmlElementNode, fallback: string): string {
  const id = node.attrs.id ? ` #${node.attrs.id}` : '';
  const className = node.attrs.class ? ` .${node.attrs.class.split(/\s+/)[0]}` : '';
  return `${fallback}${id}${className}`.trim();
}

function headingSize(tagName: string): number | undefined {
  if (tagName === 'h1') return 48;
  if (tagName === 'h2') return 36;
  if (tagName === 'h3') return 28;
  if (tagName === 'h4') return 22;
  if (tagName === 'h5') return 18;
  if (tagName === 'h6') return 16;
  return undefined;
}

function isHidden(style: Record<string, string>, node: HtmlElementNode): boolean {
  return (
    node.attrs.hidden != null ||
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0' ||
    node.attrs['aria-hidden'] === 'true'
  );
}

function resolveUrl(raw: string | undefined, baseUrl?: string): string | undefined {
  if (!raw) return undefined;
  try {
    return baseUrl ? new URL(raw, baseUrl).toString() : new URL(raw).toString();
  } catch {
    return undefined;
  }
}

function serializeElement(node: HtmlElementNode): string {
  const attrs = Object.entries(node.attrs)
    .map(([name, value]) => (value ? `${name}="${value.replace(/"/g, '&quot;')}"` : name))
    .join(' ');
  const open = attrs ? `<${node.tagName} ${attrs}>` : `<${node.tagName}>`;
  if (node.selfClosing) return open;
  return `${open}${node.children.map(serializeNode).join('')}</${node.tagName}>`;
}

function serializeNode(node: HtmlNode): string {
  if (node.kind === 'text') return node.text;
  return serializeElement(node);
}

function textNode(
  content: string,
  node: HtmlElementNode,
  inheritedStyle?: Record<string, string>,
): Record<string, unknown> {
  const style = { ...(inheritedStyle ?? {}), ...parseStyle(node.attrs.style) };
  const fontSize = parsePx(style['font-size']) ?? headingSize(node.tagName) ?? (node.tagName === 'small' ? 12 : 16);
  const fontStyle = fontStyleFromWeight(
    style['font-weight'],
    node.tagName.startsWith('h') || node.tagName === 'strong' || node.tagName === 'b',
  );
  const fill = normalizeColor(style.color);
  const width = parsePx(style.width);
  const result: Record<string, unknown> = {
    type: 'text',
    name: nodeName(node, `Text / ${node.tagName}`),
    content,
    fontSize,
    layoutSizingHorizontal: width ? 'FIXED' : 'FILL',
  };
  if (width) result.width = width;
  if (fontStyle) result.fontStyle = fontStyle;
  if (fill && fill !== '#FFFFFF00') result.fill = fill;
  const lineHeight = parsePx(style['line-height']);
  if (lineHeight) result.lineHeight = lineHeight;
  if (style['text-align']) {
    result.textAlignHorizontal = style['text-align'].toUpperCase() === 'CENTER' ? 'CENTER' : undefined;
  }
  if (style['text-decoration']?.includes('underline')) result.textDecoration = 'UNDERLINE';
  return result;
}

function elementFrameBase(node: HtmlElementNode, style: Record<string, string>): Record<string, unknown> {
  const display = style.display;
  const flexDirection = style['flex-direction'];
  const isRow =
    display === 'flex' || display === 'inline-flex'
      ? flexDirection !== 'column'
      : node.tagName === 'nav' || node.tagName === 'ul';
  const fill =
    normalizeColor(style['background-color']) ??
    normalizeColor(style.background?.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|\b[a-zA-Z]+\b)/)?.[1]);
  const borderColor =
    normalizeColor(style['border-color']) ??
    normalizeColor(style.border?.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|\b[a-zA-Z]+\b)/)?.[1]);
  const width = parsePx(style.width) ?? parsePx(node.attrs.width);
  const height = parsePx(style.height) ?? parsePx(node.attrs.height);
  const padding = parseSpacing(style, 'padding');
  const margin = parseSpacing(style, 'margin');
  const gap = parsePx(style.gap) ?? parsePx(style['column-gap']) ?? parsePx(style['row-gap']);
  const result: Record<string, unknown> = {
    type: 'frame',
    name: nodeName(node, `HTML / ${node.tagName}`),
    layoutMode: isRow ? 'HORIZONTAL' : 'VERTICAL',
    itemSpacing: gap ?? margin ?? 12,
    padding: padding ?? (node.tagName === 'button' || node.tagName === 'a' ? 12 : 0),
    layoutSizingHorizontal: width ? 'FIXED' : 'FILL',
    layoutSizingVertical: height ? 'FIXED' : 'HUG',
  };
  if (width) result.width = width;
  if (height) result.height = height;
  if (fill && fill !== '#FFFFFF00') result.fill = fill;
  if (borderColor && borderColor !== '#FFFFFF00') result.strokeColor = borderColor;
  const strokeWeight = parsePx(style['border-width']) ?? parsePx(style.border);
  if (strokeWeight) result.strokeWeight = strokeWeight;
  const radius = parsePx(style['border-radius']);
  if (radius) result.cornerRadius = radius;
  if (node.tagName === 'header') result.role = 'header';
  if (node.tagName === 'nav') result.role = 'navigation';
  if (node.tagName === 'button') {
    result.role = 'button';
    result.interactiveKind = fill ? 'button-solid' : borderColor ? 'button-outline' : 'button-ghost';
    result.layoutMode = 'HORIZONTAL';
    result.primaryAxisAlignItems = 'CENTER';
    result.counterAxisAlignItems = 'CENTER';
  }
  if (node.tagName === 'a') {
    result.role = 'link';
    result.interactiveKind = 'link-standalone';
  }
  return result;
}

function convertNode(node: HtmlNode, ctx: ConvertContext, depth: number): Record<string, unknown> | null {
  if (ctx.nodeCount >= ctx.maxNodes) {
    ctx.warnings.push(`Max node limit reached (${ctx.maxNodes}); remaining HTML was skipped.`);
    return null;
  }
  if (depth > ctx.maxDepth) {
    ctx.warnings.push(`Max depth reached (${ctx.maxDepth}); nested HTML was flattened/skipped.`);
    return null;
  }

  if (node.kind === 'text') {
    const content = node.text.trim();
    if (!content) return null;
    ctx.nodeCount++;
    return {
      type: 'text',
      name: 'Text',
      content,
      fontSize: 16,
      layoutSizingHorizontal: 'FILL',
    };
  }

  const style = parseStyle(node.attrs.style);
  if (isHidden(style, node)) return null;
  if (IGNORED_TAGS.has(node.tagName)) return null;
  if (node.tagName === 'br') return null;
  if (node.tagName === 'hr') {
    ctx.nodeCount++;
    return { type: 'rectangle', name: 'Divider', height: 1, fill: '#E5E7EB', layoutSizingHorizontal: 'FILL' };
  }
  if (node.tagName === 'svg') {
    ctx.nodeCount++;
    return { type: 'svg', name: nodeName(node, 'SVG'), svg: serializeElement(node) };
  }
  if (node.tagName === 'img') {
    ctx.nodeCount++;
    const src = resolveUrl(node.attrs.src, ctx.baseUrl);
    const width = parsePx(style.width) ?? parsePx(node.attrs.width) ?? 320;
    const height = parsePx(style.height) ?? parsePx(node.attrs.height) ?? 180;
    const imageNode: Record<string, unknown> = {
      type: 'frame',
      name: node.attrs.alt ? `Image / ${node.attrs.alt}` : nodeName(node, 'Image'),
      width,
      height,
      fill: '#E5E7EB',
      cornerRadius: parsePx(style['border-radius']) ?? 0,
      layoutSizingHorizontal: 'FIXED',
      layoutSizingVertical: 'FIXED',
    };
    if (src) imageNode.imageUrl = src;
    else ctx.warnings.push(`Image "${node.attrs.src ?? ''}" could not be resolved to an absolute URL.`);
    return imageNode;
  }
  if (node.tagName === 'input' || node.tagName === 'textarea' || node.tagName === 'select') {
    ctx.nodeCount++;
    const placeholder =
      node.attrs.placeholder ?? node.attrs.value ?? (node.tagName === 'select' ? 'Select option' : 'Input');
    return {
      type: 'frame',
      name: nodeName(node, `Input / ${node.attrs.type ?? node.tagName}`),
      role: 'input',
      layoutMode: 'HORIZONTAL',
      counterAxisAlignItems: 'CENTER',
      paddingLeft: 12,
      paddingRight: 12,
      height: parsePx(style.height) ?? 44,
      fill: normalizeColor(style['background-color']) ?? '#FFFFFF',
      strokeColor: normalizeColor(style['border-color']) ?? '#D1D5DB',
      strokeWeight: 1,
      cornerRadius: parsePx(style['border-radius']) ?? 8,
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'FIXED',
      children: [{ type: 'text', name: 'Placeholder', content: placeholder, fill: '#6B7280', fontSize: 14 }],
    };
  }

  const content = textContent(node);
  if (content && (TEXT_TAGS.has(node.tagName) || directTextOnly(node))) {
    if (node.tagName === 'button' || node.tagName === 'a') {
      const frame = elementFrameBase(node, style);
      ctx.nodeCount++;
      return {
        ...frame,
        children: [textNode(content, node, style)],
      };
    }
    ctx.nodeCount++;
    return textNode(content, node);
  }

  const children = node.children
    .map((child) => convertNode(child, ctx, depth + 1))
    .filter((child): child is Record<string, unknown> => child != null);
  if (children.length === 0 && !BLOCK_TAGS.has(node.tagName)) return null;

  ctx.nodeCount++;
  return {
    ...elementFrameBase(node, style),
    children,
  };
}

export function htmlToCreateFramePayload(
  source: Pick<HtmlImportSource, 'html' | 'title' | 'url' | 'filePath'>,
  options: HtmlImportOptions = {},
): { payload: HtmlImportPayload; warnings: string[]; stats: { nodeCount: number } } {
  const root = parseHtml(source.html);
  const ctx: ConvertContext = {
    baseUrl: options.baseUrl ?? source.url ?? (source.filePath ? `file://${source.filePath}` : undefined),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    nodeCount: 0,
    warnings: [],
  };
  const children = root.children
    .map((child) => convertNode(child, ctx, 1))
    .filter((child): child is Record<string, unknown> => child != null);

  const payload: HtmlImportPayload = {
    name: options.name ?? source.title ?? (source.filePath ? basename(source.filePath) : 'Imported HTML'),
    role: 'screen',
    width: options.width ?? DEFAULT_WIDTH,
    ...(options.height ? { height: options.height } : {}),
    ...(options.x != null ? { x: options.x } : {}),
    ...(options.y != null ? { y: options.y } : {}),
    ...(options.parentId ? { parentId: options.parentId } : {}),
    layoutMode: 'VERTICAL',
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
    fill: '#FFFFFF',
    padding: 0,
    itemSpacing: 0,
    children:
      children.length > 0
        ? children
        : [{ type: 'text', name: 'Empty HTML', content: 'No visible HTML content', fontSize: 16 }],
  };
  return { payload, warnings: [...new Set(ctx.warnings)], stats: { nodeCount: ctx.nodeCount } };
}

function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof HtmlImportError) {
    return { ok: false, code: err.code, error: err.message };
  }
  if (err instanceof Error) {
    return { ok: false, code: 'HTML_IMPORT_ERROR', error: err.message };
  }
  return { ok: false, code: 'HTML_IMPORT_ERROR', error: String(err) };
}

function sourceMetadata(source: HtmlImportSource): Record<string, unknown> {
  return {
    kind: source.kind,
    byteLength: source.byteLength,
    ...(source.filePath ? { filePath: source.filePath } : {}),
    ...(source.url ? { url: source.url } : {}),
    ...(source.title ? { title: source.title } : {}),
  };
}

export function registerHtmlImportTools(server: McpServer, bridge: Bridge): void {
  server.tool(
    'import_html',
    'Convert static HTML into editable Figma layers through FigCraft create_frame. ' +
      'Supports inline HTML, absolute local HTML files, and simple http(s) URLs. ' +
      'This native path maps semantic HTML, inline styles, images, inputs, buttons, and basic layout into a declarative children tree.',
    {
      html: z.string().optional().describe('Raw HTML string. Provide exactly one of html, filePath, or url.'),
      filePath: z.string().optional().describe('Absolute path to a local .html file.'),
      url: z.string().optional().describe('http(s) URL to fetch static HTML from.'),
      baseUrl: z
        .string()
        .optional()
        .describe('Base URL for resolving relative image/link URLs. Defaults to url when provided.'),
      parentId: z.string().optional().describe('Optional parent node ID. Defaults to current page.'),
      name: z.string().optional().describe('Root frame name. Defaults to the HTML title or source filename.'),
      x: z.number().optional().describe('Root frame X position.'),
      y: z.number().optional().describe('Root frame Y position.'),
      width: z.number().positive().optional().describe(`Root frame width in px. Default ${DEFAULT_WIDTH}.`),
      height: z.number().positive().optional().describe('Optional root frame fixed height in px.'),
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Maximum HTML depth to convert. Default ${DEFAULT_MAX_DEPTH}.`),
      maxNodes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Maximum generated child nodes. Default ${DEFAULT_MAX_NODES}.`),
      dryRun: z
        .boolean()
        .optional()
        .describe('When true, return the generated create_frame payload without writing to Figma.'),
    },
    async ({ html, filePath, url, baseUrl, parentId, name, x, y, width, height, maxDepth, maxNodes, dryRun }) => {
      try {
        const source = await loadHtmlImportSource({ html, filePath, url });
        const { payload, warnings, stats } = htmlToCreateFramePayload(source, {
          name,
          parentId,
          x,
          y,
          width,
          height,
          maxDepth,
          maxNodes,
          baseUrl,
        });
        if (dryRun) {
          return jsonResponse({ ok: true, dryRun: true, payload, source: sourceMetadata(source), warnings, stats });
        }
        const result = (await bridge.request(
          'create_frame',
          payload as unknown as Record<string, unknown>,
          60_000,
          'create_frame',
          true,
        )) as Record<string, unknown>;
        return jsonResponse({ ...result, source: sourceMetadata(source), warnings, stats, payload });
      } catch (err) {
        return { ...jsonResponse(errorPayload(err)), isError: true };
      }
    },
  );
}
