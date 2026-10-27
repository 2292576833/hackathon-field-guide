import qrcode from "qrcode-generator";

/** Produce vector cells locally; never send the invitation token to a QR service. */
export function invitationQrCode(value: string): { path: string; size: number } | null {
  if (!value || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !/^\/app\/join\/[A-Za-z0-9_-]{16,256}$/.test(url.pathname)) return null;
  try {
    const code = qrcode(0, "M");
    code.addData(url.href, "Byte");
    code.make();
    const count = code.getModuleCount(), cells: string[] = [];
    for (let row = 0; row < count; row++) for (let column = 0; column < count; column++) {
      if (code.isDark(row, column)) cells.push(`M${column + 4},${row + 4}h1v1h-1z`);
    }
    return { path: cells.join(""), size: count + 8 };
  } catch { return null; }
}
