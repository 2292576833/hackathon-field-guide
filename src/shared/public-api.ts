/** Private data is cleared on session rejection; these exact public reads remain visible. */
export function isPublicApiRead(path: string): boolean {
 return /^\/(system\/status|dev\/mailbox|library|event-discoveries|inspiration|events|resources|skills|skill-bundles|skill-agents|navigator\/intro)(?:\b|\/|\?)/.test(path)
  || /^\/competitions(?:\/[A-Za-z0-9_-]{1,128}(?:\/(?:registration-form|results|teams\/public|announcements|faq|schedule))?)?$/.test(path)
  || path === "/organizer/templates" || path === "/auth/guancha/status";
}
