import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanId } from "../../target/types/solan_id";
import {
  getProofStatus,
  identityNullifierFromProofData,
  revokeProofTx,
  submitProofTx,
} from "./solanIdClient";

export const exampleSubmitProof = async (params: {
  program: Program<SolanId>;
  user: anchor.web3.Keypair;
  verifierPrivateKey: Uint8Array;
}) => {
  const now = Math.floor(Date.now() / 1000);

  const source = { reclaim: {} } as const;
  const proofData = {
    reclaim: {
      identityHash: Array(32).fill(11),
      providerHash: Array(32).fill(12),
      responseHash: Array(32).fill(13),
      issuedAt: new anchor.BN(now),
    },
  };

  return submitProofTx({
    program: params.program,
    user: params.user,
    source,
    proofData,
    proofHash: Array(32).fill(21),
    baseScore: new anchor.BN(180),
    timestamp: new anchor.BN(now),
    attestationNonce: new anchor.BN(now),
    verifierPrivateKey: params.verifierPrivateKey,
  });
};

export const exampleVerifyProof = async (params: {
  program: Program<SolanId>;
  user: anchor.web3.PublicKey;
}) => getProofStatus({ program: params.program, user: params.user });

export const exampleRevokeProof = async (params: {
  program: Program<SolanId>;
  user: anchor.web3.Keypair;
}) => {
  const source = { reclaim: {} } as const;
  const proofData = {
    reclaim: {
      identityHash: Array(32).fill(11),
      providerHash: Array(32).fill(12),
      responseHash: Array(32).fill(13),
      issuedAt: new anchor.BN(0),
    },
  };

  const identityNullifier = identityNullifierFromProofData(source, proofData);

  return revokeProofTx({
    program: params.program,
    user: params.user,
    source,
    identityNullifier,
  });
};
