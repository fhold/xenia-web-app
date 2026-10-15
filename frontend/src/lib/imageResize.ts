/**
 * Foto im Browser verkleinern, bevor es hochgeladen wird.
 *
 * Auf der Box gibt es keinen Bildskalierer (kein sharp, kein ImageMagick) und
 * bei 1 GB RAM soll auch keiner hin. Ein Tablet-Foto sind 3-8 MB; verkleinert
 * bleiben ~150 kB uebrig, und damit passt der Upload als Base64 in eine
 * normale JSON-Route ohne weitere Abhaengigkeit auf der Serverseite.
 *
 * ⚠ Handyfotos sind fast immer gedreht gespeichert (EXIF-Orientierung). Ohne
 * `imageOrientation: "from-image"` liegt die Tuete quer, und zwar erst nach dem
 * Hochladen, wenn die Information schon weg ist.
 */

/** Laengste Kante nach dem Verkleinern. */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

export interface ResizedImage {
  /** Base64 ohne data:-Praefix — genau das, was die PUT-Route erwartet. */
  base64: string;
  width: number;
  height: number;
  bytes: number;
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Aelteres WebKit kennt die Option nicht: <img> wendet die EXIF-Drehung
    // von sich aus an, kostet aber einen Object-URL.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => { resolve(); };
        img.onerror = () => { reject(new Error("decode failed")); };
        img.src = url;
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export async function resizeForUpload(file: File): Promise<ResizedImage> {
  const src = await loadBitmap(file);
  const sw = "width" in src ? src.width : 0;
  const sh = "height" in src ? src.height : 0;
  if (!sw || !sh) throw new Error("Bild konnte nicht gelesen werden");

  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas nicht verfügbar");
  ctx.drawImage(src as CanvasImageSource, 0, 0, w, h);
  if ("close" in src) src.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
  });
  if (!blob) throw new Error("Bild konnte nicht kodiert werden");

  const buf = await blob.arrayBuffer();
  let binary = "";
  const view = new Uint8Array(buf);
  // In Haeppchen, sonst sprengt ein grosses Bild das Argumentlimit von apply().
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return { base64: btoa(binary), width: w, height: h, bytes: view.length };
}
