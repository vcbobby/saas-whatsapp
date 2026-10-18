/**
 * Reduce una foto o captura del comprobante en el navegador: JPG de máx. 1600 px de lado y menos de 1,5 MB.
 * Devuelve el base64 sin prefijo. Lanza un Error con un mensaje para la persona si no se puede leer.
 */
export async function compressProof(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("El comprobante debe ser una imagen (JPG, PNG o captura de pantalla).");
  if (file.size > 25 * 1024 * 1024) throw new Error("La imagen es demasiado grande.");
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new Error("No pude leer esa imagen. Prueba con una captura en JPG o PNG."); }
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Tu navegador no pudo preparar la imagen.");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); // fondo blanco por si la captura es transparente
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= 1_500_000) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(bin);
    }
  }
  throw new Error("No logré reducir la imagen lo suficiente. Recórtala o envía una captura más pequeña.");
}
