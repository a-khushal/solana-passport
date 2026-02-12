import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { SolanId } from "../../target/types/solan_id";

type SourceInput =
  | { reclaim: {} }
  | { gitcoinPassport: {} }
  | { worldId: {} }
  | { brightId: {} }
  | { lens: {} }
  | { twitter: {} }
  | { google: {} }
  | { discord: {} };

type SourceProofDataInput = Record<string, unknown>;

export type SubmitProofParams = {
  program: Program<SolanId>;
  user: anchor.web3.Keypair;
  source: SourceInput;
  proofData: SourceProofDataInput;
  proofHash: Uint8Array | number[];
  baseScore: BN | number | bigint;
  timestamp: BN | number | bigint;
  attestationNonce: BN | number | bigint;
  verifierPrivateKey?: Uint8Array;
  attestationInstruction?: anchor.web3.TransactionInstruction;
};

const SOURCE_INDEX: Record<string, number> = {
  reclaim: 0,
  gitcoinPassport: 1,
  worldId: 2,
  brightId: 3,
  lens: 4,
  twitter: 5,
  google: 6,
  discord: 7,
};

const asBN = (v: BN | number | bigint): BN =>
  BN.isBN(v) ? v : new BN(v.toString());

const toFixed32 = (v: Uint8Array | number[]): Buffer => {
  const buf = Buffer.from(v);
  if (buf.length !== 32) {
    throw new Error("Expected 32-byte value");
  }
  return buf;
};

const sourceKey = (source: SourceInput): string => {
  const key = Object.keys(source)[0];
  if (!key || !(key in SOURCE_INDEX)) {
    throw new Error("Unsupported source");
  }
  return key;
};

const u64Le = (v: BN | number | bigint): Buffer => {
  const bn = asBN(v);
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(bn.toString()));
  return out;
};

const i64Le = (v: BN | number | bigint): Buffer => {
  const bn = asBN(v);
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(bn.toString()));
  return out;
};

export const deriveRegistryPda = (programId: anchor.web3.PublicKey) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("registry")],
    programId
  )[0];

export const deriveScoringConfigPda = (programId: anchor.web3.PublicKey) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("scoring_config")],
    programId
  )[0];

export const deriveUserProofPda = (
  programId: anchor.web3.PublicKey,
  user: anchor.web3.PublicKey
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_proof"), user.toBuffer()],
    programId
  )[0];

export const deriveIndividualProofPda = (
  programId: anchor.web3.PublicKey,
  user: anchor.web3.PublicKey,
  source: SourceInput
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("individual_proof"),
      user.toBuffer(),
      Buffer.from([SOURCE_INDEX[sourceKey(source)]]),
    ],
    programId
  )[0];

export const deriveIdentityNullifierPda = (
  programId: anchor.web3.PublicKey,
  identityNullifier: Uint8Array | number[]
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("identity_nullifier"), toFixed32(identityNullifier)],
    programId
  )[0];

export const deriveAttestationNoncePda = (
  programId: anchor.web3.PublicKey,
  registry: anchor.web3.PublicKey,
  nonce: BN | number | bigint
) =>
  anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("attestation_nonce"), registry.toBuffer(), u64Le(nonce)],
    programId
  )[0];

export const identityNullifierFromProofData = (
  source: SourceInput,
  proofData: SourceProofDataInput
): number[] => {
  if ("reclaim" in source && proofData["reclaim"]) {
    return (proofData["reclaim"] as any).identityHash;
  }
  if ("gitcoinPassport" in source && proofData["gitcoinPassport"]) {
    return (proofData["gitcoinPassport"] as any).didHash;
  }
  if ("worldId" in source && proofData["worldId"]) {
    return (proofData["worldId"] as any).nullifierHash;
  }
  throw new Error("Cannot extract identity nullifier for source");
};

export const buildAttestationMessage = (params: {
  programId: anchor.web3.PublicKey;
  registry: anchor.web3.PublicKey;
  user: anchor.web3.PublicKey;
  source: SourceInput;
  identityNullifier: Uint8Array | number[];
  attestationNonce: BN | number | bigint;
  baseScore: BN | number | bigint;
  timestamp: BN | number | bigint;
  proofHash: Uint8Array | number[];
}) => {
  return Buffer.concat([
    Buffer.from("sid1"),
    params.programId.toBuffer(),
    params.registry.toBuffer(),
    params.user.toBuffer(),
    Buffer.from([SOURCE_INDEX[sourceKey(params.source)]]),
    toFixed32(params.identityNullifier),
    u64Le(params.attestationNonce),
    u64Le(params.baseScore),
    i64Le(params.timestamp),
    toFixed32(params.proofHash),
  ]);
};

export const createVerifierAttestationInstruction = (params: {
  verifierPrivateKey: Uint8Array;
  message: Uint8Array;
}) =>
  anchor.web3.Ed25519Program.createInstructionWithPrivateKey({
    privateKey: params.verifierPrivateKey,
    message: params.message,
  });

export const submitProofTx = async (params: SubmitProofParams) => {
  const registry = deriveRegistryPda(params.program.programId);
  const scoringConfig = deriveScoringConfigPda(params.program.programId);
  const userProof = deriveUserProofPda(
    params.program.programId,
    params.user.publicKey
  );
  const individualProof = deriveIndividualProofPda(
    params.program.programId,
    params.user.publicKey,
    params.source
  );

  const identityNullifier = identityNullifierFromProofData(
    params.source,
    params.proofData
  );
  const identityNullifierRegistry = deriveIdentityNullifierPda(
    params.program.programId,
    identityNullifier
  );
  const attestationNonceRegistry = deriveAttestationNoncePda(
    params.program.programId,
    registry,
    params.attestationNonce
  );

  const attestationInstruction =
    params.attestationInstruction ??
    createVerifierAttestationInstruction({
      verifierPrivateKey: params.verifierPrivateKey as Uint8Array,
      message: buildAttestationMessage({
        programId: params.program.programId,
        registry,
        user: params.user.publicKey,
        source: params.source,
        identityNullifier,
        attestationNonce: params.attestationNonce,
        baseScore: params.baseScore,
        timestamp: params.timestamp,
        proofHash: params.proofHash,
      }),
    });

  return params.program.methods
    .submitProof(
      Array.from(toFixed32(params.proofHash)),
      params.source as any,
      identityNullifier,
      asBN(params.attestationNonce),
      params.proofData as any,
      asBN(params.baseScore),
      asBN(params.timestamp)
    )
    .preInstructions([attestationInstruction])
    .accountsStrict({
      registry,
      userProof,
      individualProof,
      identityNullifierRegistry,
      attestationNonceRegistry,
      scoringConfig,
      instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      user: params.user.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([params.user])
    .rpc();
};

export const getProofStatus = async (params: {
  program: Program<SolanId>;
  user: anchor.web3.PublicKey;
}) => {
  const registry = deriveRegistryPda(params.program.programId);
  const userProof = deriveUserProofPda(params.program.programId, params.user);

  return params.program.methods
    .verifyProof()
    .accountsStrict({
      userProof,
      registry,
      user: params.user,
    })
    .view();
};

export const revokeProofTx = async (params: {
  program: Program<SolanId>;
  user: anchor.web3.Keypair;
  source: SourceInput;
  identityNullifier: Uint8Array | number[];
}) => {
  const registry = deriveRegistryPda(params.program.programId);
  const userProof = deriveUserProofPda(
    params.program.programId,
    params.user.publicKey
  );
  const individualProof = deriveIndividualProofPda(
    params.program.programId,
    params.user.publicKey,
    params.source
  );
  const identityNullifierRegistry = deriveIdentityNullifierPda(
    params.program.programId,
    params.identityNullifier
  );

  return params.program.methods
    .revokeProof(params.source as any)
    .accountsStrict({
      registry,
      userProof,
      individualProof,
      identityNullifierRegistry,
      user: params.user.publicKey,
    })
    .signers([params.user])
    .rpc();
};

export const updateMinScoreTx = async (params: {
  program: Program<SolanId>;
  authority: anchor.web3.Keypair;
  newMinScore: BN | number | bigint;
}) => {
  const registry = deriveRegistryPda(params.program.programId);
  return params.program.methods
    .updateMinScore(asBN(params.newMinScore))
    .accountsStrict({
      registry,
      authority: params.authority.publicKey,
    })
    .signers([params.authority])
    .rpc();
};

export const updateRegistryConfigTx = async (params: {
  program: Program<SolanId>;
  authority: anchor.web3.Keypair;
  cooldownPeriod: BN | number | bigint;
  diversityBonusPercent: number;
  proofTtlSeconds: BN | number | bigint;
}) => {
  const registry = deriveRegistryPda(params.program.programId);
  return params.program.methods
    .updateRegistryConfig(
      asBN(params.cooldownPeriod),
      params.diversityBonusPercent,
      asBN(params.proofTtlSeconds)
    )
    .accountsStrict({
      registry,
      authority: params.authority.publicKey,
    })
    .signers([params.authority])
    .rpc();
};

export const initiateVerifierRotationTx = async (params: {
  program: Program<SolanId>;
  authority: anchor.web3.Keypair;
  newVerifierAuthority: anchor.web3.PublicKey;
  delaySeconds: BN | number | bigint;
}) => {
  const registry = deriveRegistryPda(params.program.programId);
  return params.program.methods
    .initiateVerifierRotation(
      params.newVerifierAuthority,
      asBN(params.delaySeconds)
    )
    .accountsStrict({
      registry,
      authority: params.authority.publicKey,
    })
    .signers([params.authority])
    .rpc();
};

export const finalizeVerifierRotationTx = async (params: {
  program: Program<SolanId>;
  authority: anchor.web3.Keypair;
}) => {
  const registry = deriveRegistryPda(params.program.programId);
  return params.program.methods
    .finalizeVerifierRotation()
    .accountsStrict({
      registry,
      authority: params.authority.publicKey,
    })
    .signers([params.authority])
    .rpc();
};
