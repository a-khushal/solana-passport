type AnchorLikeError = {
  error?: {
    errorCode?: {
      code?: string;
      number?: number;
    };
    errorMessage?: string;
  };
  message?: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  InvalidTimestamp: "The submitted proof timestamp is in the future.",
  ProofExpired: "The proof is too old. Please refresh and submit a new proof.",
  Unauthorized: "You are not authorized for this action.",
  Overflow: "Score calculation overflowed. Please use a smaller score input.",
  ProofAlreadyRevoked: "This proof was already revoked.",
  CooldownPeriodActive: "Please wait for cooldown before submitting again.",
  InvalidConfig: "Configuration values are invalid.",
  SourcePayloadMismatch: "Proof payload type does not match selected source.",
  InvalidSourceProofData: "Proof payload is missing required fields or values.",
  InvalidAttestationInstruction:
    "Missing or malformed verifier attestation instruction.",
  InvalidAttestationMessage:
    "Attestation signature does not match the expected proof message.",
  InvalidIdentityNullifier:
    "Identity nullifier is invalid for the selected source payload.",
  DuplicateIdentityClaim:
    "This identity has already been linked to another wallet.",
  IdentityRevokedPermanent: "This identity was revoked and cannot be reused.",
  AttestationNonceAlreadyUsed: "This attestation nonce was already used.",
  NoVerifierRotationPending: "No verifier rotation is currently pending.",
  VerifierRotationNotReady: "Verifier rotation delay has not elapsed yet.",
  ConstraintSeeds:
    "One of the provided accounts does not match required PDA seeds.",
};

export const getSolanIdErrorCode = (err: unknown): string | null => {
  const e = err as AnchorLikeError;
  return e?.error?.errorCode?.code ?? null;
};

export const getSolanIdErrorMessage = (err: unknown): string => {
  const code = getSolanIdErrorCode(err);
  if (code && ERROR_MESSAGES[code]) {
    return ERROR_MESSAGES[code];
  }

  const e = err as AnchorLikeError;
  if (e?.error?.errorMessage) {
    return e.error.errorMessage;
  }
  if (e?.message) {
    return e.message;
  }

  return "Unexpected error. Please try again.";
};

export const isSolanIdError = (err: unknown, code: string): boolean =>
  getSolanIdErrorCode(err) === code;
