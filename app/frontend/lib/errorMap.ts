type AnchorLikeError = {
  error?: {
    errorCode?: {
      code?: string;
    };
    errorMessage?: string;
  };
  message?: string;
};

const MESSAGES: Record<string, string> = {
  InvalidTimestamp: "Timestamp is in the future.",
  ProofExpired: "Proof timestamp is too old.",
  Unauthorized: "You are not authorized for this action.",
  Overflow: "Score calculation overflowed.",
  ProofAlreadyRevoked: "This proof was already revoked.",
  CooldownPeriodActive: "Cooldown is still active for this user.",
  InvalidConfig: "Config values are invalid.",
  SourcePayloadMismatch: "Payload does not match selected source.",
  InvalidSourceProofData: "Payload fields are invalid for this source.",
  InvalidAttestationInstruction:
    "Missing or invalid verifier attestation instruction.",
  InvalidAttestationMessage:
    "Attestation signature does not match message fields.",
  InvalidIdentityNullifier: "Identity nullifier is invalid.",
  DuplicateIdentityClaim: "Identity already linked to another wallet.",
  IdentityRevokedPermanent: "Identity is permanently revoked.",
  AttestationNonceAlreadyUsed: "Attestation nonce already used.",
  NoVerifierRotationPending: "No verifier rotation is pending.",
  VerifierRotationNotReady: "Rotation delay has not elapsed yet.",
  ConstraintSeeds: "One or more account addresses are invalid for the action.",
};

export const getFriendlyError = (err: unknown): string => {
  const e = err as AnchorLikeError;
  const code = e?.error?.errorCode?.code;
  if (code && MESSAGES[code]) {
    return MESSAGES[code];
  }
  if (e?.error?.errorMessage) {
    return e.error.errorMessage;
  }
  if (e?.message) {
    return e.message;
  }
  return "Unexpected error.";
};
