import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Ed25519Program, PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "./solan_id.json";

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || (idl as { address: string }).address
);

const toBn = (value: string | number | bigint) => new BN(value.toString());

const sourceToEnum = (source: string) => {
  switch (source) {
    case "reclaim":
      return { reclaim: {} };
    case "gitcoinPassport":
      return { gitcoinPassport: {} };
    case "worldId":
      return { worldId: {} };
    default:
      throw new Error(`Unsupported source: ${source}`);
  }
};

const sourceIndex = (source: string) => {
  switch (source) {
    case "reclaim":
      return 0;
    case "gitcoinPassport":
      return 1;
    case "worldId":
      return 2;
    default:
      throw new Error(`Unsupported source: ${source}`);
  }
};

const parseHex32 = (value: string) => {
  const clean = value.trim().replace(/^0x/, "").toLowerCase();
  if (clean.length !== 64) {
    throw new Error("Expected exactly 64 hex characters");
  }
  return Array.from(Buffer.from(clean, "hex"));
};

const parseDevVerifierSecret = () => {
  const raw = process.env.NEXT_PUBLIC_DEV_VERIFIER_SECRET_KEY;
  if (!raw) return null;

  try {
    if (raw.trim().startsWith("[")) {
      const arr = JSON.parse(raw) as number[];
      return Uint8Array.from(arr);
    }
    const arr = raw
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((n) => !Number.isNaN(n));
    return Uint8Array.from(arr);
  } catch {
    return null;
  }
};

const normalizeProofData = (source: string, input: string) => {
  const parsed = JSON.parse(input) as Record<string, unknown>;

  if (source === "reclaim" && parsed.reclaim) {
    const reclaim = parsed.reclaim as Record<string, unknown>;
    return {
      reclaim: {
        identityHash: reclaim.identityHash,
        providerHash: reclaim.providerHash,
        responseHash: reclaim.responseHash,
        issuedAt: toBn(reclaim.issuedAt as number),
      },
    };
  }

  if (source === "gitcoinPassport" && parsed.gitcoinPassport) {
    return { gitcoinPassport: parsed.gitcoinPassport };
  }

  if (source === "worldId" && parsed.worldId) {
    return { worldId: parsed.worldId };
  }

  throw new Error("Payload JSON does not match selected source");
};

const extractNullifier = (source: string, proofData: any): number[] => {
  if (source === "reclaim") return proofData.reclaim.identityHash;
  if (source === "gitcoinPassport") return proofData.gitcoinPassport.didHash;
  if (source === "worldId") return proofData.worldId.nullifierHash;
  throw new Error("Cannot extract identity nullifier from source/payload");
};

const buildAttestationMessage = (params: {
  registry: PublicKey;
  user: PublicKey;
  proofHash: number[];
  source: string;
  identityNullifier: number[];
  nonce: BN;
  baseScore: BN;
  timestamp: BN;
}) => {
  const nonce = Buffer.alloc(8);
  nonce.writeBigUInt64LE(BigInt(params.nonce.toString()));
  const score = Buffer.alloc(8);
  score.writeBigUInt64LE(BigInt(params.baseScore.toString()));
  const ts = Buffer.alloc(8);
  ts.writeBigInt64LE(BigInt(params.timestamp.toString()));

  return Buffer.concat([
    Buffer.from("sid1"),
    PROGRAM_ID.toBuffer(),
    params.registry.toBuffer(),
    params.user.toBuffer(),
    Buffer.from([sourceIndex(params.source)]),
    Buffer.from(params.identityNullifier),
    nonce,
    score,
    ts,
    Buffer.from(params.proofHash),
  ]);
};

const registryPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("registry")], PROGRAM_ID)[0];

const scoringConfigPda = () =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("scoring_config")],
    PROGRAM_ID
  )[0];

const userProofPda = (user: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("user_proof"), user.toBuffer()],
    PROGRAM_ID
  )[0];

const individualProofPda = (user: PublicKey, source: string) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("individual_proof"),
      user.toBuffer(),
      Buffer.from([sourceIndex(source)]),
    ],
    PROGRAM_ID
  )[0];

const identityNullifierPda = (identityNullifier: number[]) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("identity_nullifier"), Buffer.from(identityNullifier)],
    PROGRAM_ID
  )[0];

const attestationNoncePda = (registry: PublicKey, nonce: BN) => {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("attestation_nonce"), registry.toBuffer(), nonceBuf],
    PROGRAM_ID
  )[0];
};

export const getProgram = (
  connection: AnchorProvider["connection"],
  wallet: AnchorWallet
) => {
  const provider = new AnchorProvider(
    connection,
    wallet,
    AnchorProvider.defaultOptions()
  );
  return new Program(idl as Idl, provider);
};

export const submitProof = async (params: {
  program: Program;
  user: PublicKey;
  source: string;
  score: string;
  timestamp: string;
  nonce: string;
  proofHashHex: string;
  identityNullifierHex: string;
  payloadJson: string;
}) => {
  const verifierSecret = parseDevVerifierSecret();
  if (!verifierSecret || verifierSecret.length < 64) {
    throw new Error(
      "Missing NEXT_PUBLIC_DEV_VERIFIER_SECRET_KEY for local attestation signing"
    );
  }

  const registry = registryPda();
  const source = sourceToEnum(params.source);
  const proofData = normalizeProofData(params.source, params.payloadJson);

  const proofHash = parseHex32(params.proofHashHex);
  const identityNullifierInput = parseHex32(params.identityNullifierHex);
  const identityNullifierFromPayload = extractNullifier(
    params.source,
    proofData
  );

  if (
    Buffer.compare(
      Buffer.from(identityNullifierInput),
      Buffer.from(identityNullifierFromPayload)
    ) !== 0
  ) {
    throw new Error(
      "Identity nullifier field must match payload-derived nullifier"
    );
  }

  const nonce = toBn(params.nonce);
  const baseScore = toBn(params.score);
  const timestamp = toBn(params.timestamp);

  const message = buildAttestationMessage({
    registry,
    user: params.user,
    proofHash,
    source: params.source,
    identityNullifier: identityNullifierInput,
    nonce,
    baseScore,
    timestamp,
  });

  const attestationIx = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: verifierSecret,
    message,
  });

  return params.program.methods
    .submitProof(
      proofHash,
      source,
      identityNullifierInput,
      nonce,
      proofData,
      baseScore,
      timestamp
    )
    .preInstructions([attestationIx])
    .accountsStrict({
      registry,
      userProof: userProofPda(params.user),
      individualProof: individualProofPda(params.user, params.source),
      identityNullifierRegistry: identityNullifierPda(identityNullifierInput),
      attestationNonceRegistry: attestationNoncePda(registry, nonce),
      scoringConfig: scoringConfigPda(),
      instructionsSysvar: new PublicKey(
        "Sysvar1nstructions1111111111111111111111111"
      ),
      user: params.user,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
};

export const verifyProof = async (params: {
  program: Program;
  user: string;
}) => {
  const user = new PublicKey(params.user);
  return params.program.methods
    .verifyProof()
    .accountsStrict({
      userProof: userProofPda(user),
      registry: registryPda(),
      user,
    })
    .view();
};

export const revokeProof = async (params: {
  program: Program;
  user: PublicKey;
  source: string;
  identityNullifierHex: string;
}) => {
  const source = sourceToEnum(params.source);
  const identityNullifier = parseHex32(params.identityNullifierHex);

  return params.program.methods
    .revokeProof(source)
    .accountsStrict({
      registry: registryPda(),
      userProof: userProofPda(params.user),
      individualProof: individualProofPda(params.user, params.source),
      identityNullifierRegistry: identityNullifierPda(identityNullifier),
      user: params.user,
    })
    .rpc();
};

export const updateRegistryConfig = async (params: {
  program: Program;
  authority: PublicKey;
  cooldown: string;
  bonus: string;
  ttl: string;
}) => {
  return params.program.methods
    .updateRegistryConfig(
      toBn(params.cooldown),
      Number(params.bonus),
      toBn(params.ttl)
    )
    .accountsStrict({
      registry: registryPda(),
      authority: params.authority,
    })
    .rpc();
};

export const initiateRotation = async (params: {
  program: Program;
  authority: PublicKey;
  verifier: string;
  delay: string;
}) => {
  return params.program.methods
    .initiateVerifierRotation(
      new PublicKey(params.verifier),
      toBn(params.delay)
    )
    .accountsStrict({
      registry: registryPda(),
      authority: params.authority,
    })
    .rpc();
};

export const finalizeRotation = async (params: {
  program: Program;
  authority: PublicKey;
}) => {
  return params.program.methods
    .finalizeVerifierRotation()
    .accountsStrict({
      registry: registryPda(),
      authority: params.authority,
    })
    .rpc();
};
