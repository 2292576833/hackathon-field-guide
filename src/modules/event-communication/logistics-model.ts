import type { Clock, IdGenerator } from "../../shared/contracts.ts";
import type { DatabasePort } from "../../shared/persistence.ts";
import type { EventParticipationPort, HostedEventAccessPort } from "../../shared/organizer-contracts.ts";

export interface LogisticsDependencies {
  readonly database: DatabasePort;
  readonly eventAccess: HostedEventAccessPort;
  readonly participation: EventParticipationPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Root may inject a cryptographically secure generator; tests use controlled values. */
  readonly tokens?: { generate(): string };
}
export interface AccommodationFields {
  readonly userId: string;
  readonly location: string;
  readonly room: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly note: string;
}
export interface AssignAccommodationInput extends Omit<AccommodationFields, "note"> {
  readonly note?: string;
  /** 0 creates an assignment. Later corrections require the displayed revision. */
  readonly expectedRevision: number;
}
export interface AccommodationAssignment extends AccommodationFields {
  readonly id: string;
  readonly eventId: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}
export interface AccommodationImportRow extends AccommodationFields {
  readonly line: number;
  readonly expectedRevision: number;
}
export interface AccommodationImportPreview {
  readonly id: string;
  readonly eventId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly rows: readonly AccommodationImportRow[];
  readonly errors: readonly { readonly line: number; readonly message: string }[];
  readonly state: "preview" | "confirmed";
  readonly assignments: readonly AccommodationAssignment[];
}
export interface ConfirmAccommodationImportResult {
  readonly previewId: string;
  readonly assignments: readonly AccommodationAssignment[];
  readonly replayed: boolean;
}
export interface CreateVoucherTypeInput { readonly name: string; readonly uses: number; readonly expiresAt: string }
export interface VoucherType extends CreateVoucherTypeInput { readonly id: string; readonly eventId: string; readonly createdAt: string; readonly createdBy: string }
export interface IssueVoucherInput { readonly userId: string; readonly typeId: string; readonly idempotencyKey: string }
export interface MealVoucher {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly typeId: string;
  readonly name: string;
  readonly totalUses: number;
  readonly remainingUses: number;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly issuedBy: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revision: number;
  readonly state: "available" | "exhausted" | "expired" | "revoked";
}
export interface IssueVoucherResult { readonly voucher: MealVoucher; readonly token: string | null; readonly replayed: boolean }
export interface RevokeVoucherInput { readonly voucherId: string; readonly expectedRevision: number }
/** Exactly one target; voucherId means an explicitly authorized manual redemption. */
export interface RedeemVoucherInput { readonly token?: string; readonly voucherId?: string; readonly idempotencyKey: string }
export interface VoucherRedemption {
  readonly id: string;
  readonly eventId: string;
  readonly voucherId: string;
  readonly operatorUserId: string;
  readonly mode: "token" | "manual";
  readonly redeemedAt: string;
  readonly remainingUses: number;
  readonly voucherRevision: number;
}
export interface RedeemVoucherResult { readonly receipt: VoucherRedemption; readonly replayed: boolean }
export interface OwnEventServices {
  readonly eventId: string;
  readonly modules: { readonly accommodation: boolean; readonly mealVouchers: boolean };
  readonly accommodation: AccommodationAssignment | null;
  readonly vouchers: readonly MealVoucher[];
}
