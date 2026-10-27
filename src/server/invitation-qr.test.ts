import test from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { invitationQrCode } from "../components/invitation-qr-code.ts";

test("locally rendered invitation QR decodes to the same URL using an independent decoder", () => {
  const value = "https://invite.example.test:44353/app/join/" + "sampleInviteToken_2026-10-09_".repeat(2);
  const code = invitationQrCode(value);
  assert.ok(code);
  // Paint the vector cells into a readable bitmap, including the quiet zone.
  const scale = 4, width = code.size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const cell of code.path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    const left = Number(cell[1]) * scale, top = Number(cell[2]) * scale;
    for (let y = top; y < top + scale; y++) for (let x = left; x < left + scale; x++) {
      const index = (y * width + x) * 4;
      pixels[index] = pixels[index + 1] = pixels[index + 2] = 17;
    }
  }
  const result = jsQR(pixels, width, width);
  assert.equal(result?.data, value);
});

test("invitation QR rejects invalid protocols, credentials, other routes and modified token URLs", () => {
  const token = "safeFixtureToken2026";
  for (const value of ["javascript:alert(1)", `https://user:pass@example.test/app/join/${token}`,
    `https://example.test/resources`, `https://example.test/app/join/${token}?redirect=https://example.test`,
    `https://example.test/app/join/${token}#details`, "https://example.test/app/join/short", "//example.test/app/join/" + token]) {
    assert.equal(invitationQrCode(value), null);
  }
  assert.ok(invitationQrCode(`http://localhost:3000/app/join/${token}`));
});
