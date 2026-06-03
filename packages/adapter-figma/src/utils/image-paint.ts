export type ImageScaleMode = 'FILL' | 'FIT' | 'CROP' | 'TILE';

export function imagePaintFromBase64(imageData: string, scaleMode: ImageScaleMode): ImagePaint {
  const bytes = figma.base64Decode(imageData);
  const image = figma.createImage(bytes);
  return {
    type: 'IMAGE',
    scaleMode,
    imageHash: image.hash,
  };
}
