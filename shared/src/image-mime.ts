/**
 * Bildtyp aus den Magic Bytes.
 *
 * ⚠ Der vom Client behauptete Content-Type wird bewusst ignoriert. "image/jpeg"
 * auf beliebigem Inhalt waere eine Einladung, den Browser spaeter etwas anderes
 * rendern zu lassen; was zaehlt, ist der Anfang der Datei.
 */

/** Nach dem Verkleinern im Browser liegt ein Foto bei ~150 kB; 1 MB ist die
 *  grosszuegige Obergrenze, unter der die Base64-Nutzlast in einen 2-MB-Body passt. */
export const MAX_IMAGE_BYTES = 1_000_000;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** "image/jpeg" | "image/png" | "image/webp", oder null wenn es keines davon ist. */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && PNG.every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 12) {
    const tag = (from: number, to: number) =>
      String.fromCharCode(...Array.from(b.subarray(from, to)));
    if (tag(0, 4) === "RIFF" && tag(8, 12) === "WEBP") return "image/webp";
  }
  return null;
}
