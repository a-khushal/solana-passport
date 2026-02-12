import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { SolanId } from "../target/types/solan_id";

describe("SolanID", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanId as Program<SolanId>;
  const payer = provider.wallet.publicKey;
  const verifier = (provider.wallet as any).payer as anchor.web3.Keypair;
  let attestationNonce = 1;
  let hashSeed = 10;

  const registryPda = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("registry")],
    program.programId
  )[0];

  const scoringConfigPda = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("scoring_config")],
    program.programId
  )[0];

  const sourceIndex = {
    reclaim: 0,
    gitcoinPassport: 1,
    worldId: 2,
    brightId: 3,
    lens: 4,
    twitter: 5,
    google: 6,
    discord: 7,
  } as const;

  const sourceToIndex = (source: any): number => {
    if (source.reclaim) return sourceIndex.reclaim;
    if (source.gitcoinPassport) return sourceIndex.gitcoinPassport;
    if (source.worldId) return sourceIndex.worldId;
    if (source.brightId) return sourceIndex.brightId;
    if (source.lens) return sourceIndex.lens;
    if (source.twitter) return sourceIndex.twitter;
    if (source.google) return sourceIndex.google;
    if (source.discord) return sourceIndex.discord;
    throw new Error("Unsupported source in test helper");
  };

  const buildAttestationMessage = (
    user: anchor.web3.PublicKey,
    proofHash: Buffer,
    source: any,
    identityNullifier: number[],
    nonce: number,
    baseScore: anchor.BN,
    timestamp: number
  ) => {
    const sourceIdx = sourceToIndex(source);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce));
    const scoreBuf = Buffer.alloc(8);
    scoreBuf.writeBigUInt64LE(BigInt(baseScore.toString()));
    const tsBuf = Buffer.alloc(8);
    tsBuf.writeBigInt64LE(BigInt(timestamp));

    return Buffer.concat([
      Buffer.from("sid1"),
      program.programId.toBuffer(),
      registryPda.toBuffer(),
      user.toBuffer(),
      Buffer.from([sourceIdx]),
      Buffer.from(identityNullifier),
      nonceBuf,
      scoreBuf,
      tsBuf,
      proofHash,
    ]);
  };

  const hash32 = (seed: number): number[] => Array.from(Buffer.alloc(32, seed));
  const nextHash32 = (): number[] => {
    hashSeed += 1;
    return hash32(hashSeed % 255);
  };

  const sourceData = (
    kind: "reclaim" | "gitcoin" | "worldId",
    now: number,
    score = 150
  ) => {
    if (kind === "reclaim") {
      return {
        reclaim: {
          identityHash: nextHash32(),
          providerHash: nextHash32(),
          responseHash: nextHash32(),
          issuedAt: new anchor.BN(now),
        },
      };
    }
    if (kind === "gitcoin") {
      return {
        gitcoinPassport: {
          didHash: nextHash32(),
          stampCount: 3,
          passportScore: Math.max(score, 300),
          modelVersion: 1,
        },
      };
    }
    return {
      worldId: {
        nullifierHash: nextHash32(),
        merkleRoot: nextHash32(),
        verificationLevel: 1,
      },
    };
  };

  const deriveUserProofPda = (userPk: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user_proof"), userPk.toBuffer()],
      program.programId
    )[0];

  const deriveIndividualProofPda = (
    userPk: anchor.web3.PublicKey,
    index: number
  ) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("individual_proof"),
        userPk.toBuffer(),
        Buffer.from([index]),
      ],
      program.programId
    )[0];

  const deriveProofHashRegistryPda = (proofHash: Buffer) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("proof_hash"), proofHash],
      program.programId
    )[0];

  const deriveIdentityNullifierPda = (nullifier: number[]) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("identity_nullifier"), Buffer.from(nullifier)],
      program.programId
    )[0];

  const deriveAttestationNoncePda = (nonce: number) => {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce));
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("attestation_nonce"), registryPda.toBuffer(), nonceBuf],
      program.programId
    )[0];
  };

  const identityNullifierFromPayload = (
    _source: any,
    proofData: any
  ): number[] => {
    if (proofData.reclaim) return proofData.reclaim.identityHash;
    if (proofData.gitcoinPassport) return proofData.gitcoinPassport.didHash;
    if (proofData.worldId) return proofData.worldId.nullifierHash;
    throw new Error("Unsupported proof payload in test helper");
  };

  const airdrop = async (pubkey: anchor.web3.PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(
      pubkey,
      sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
  };

  const submitProof = async (
    user: anchor.web3.Keypair,
    proofHash: Buffer,
    source: any,
    proofData: any,
    baseScore: anchor.BN,
    timestamp: number,
    nonceOverride?: number
  ) => {
    const index = sourceToIndex(source);
    const identityNullifier = identityNullifierFromPayload(source, proofData);
    const nonce = nonceOverride ?? attestationNonce;
    if (nonceOverride === undefined) {
      attestationNonce += 1;
    }

    const userProofPda = deriveUserProofPda(user.publicKey);
    const individualProofPda = deriveIndividualProofPda(user.publicKey, index);
    const identityNullifierRegistryPda =
      deriveIdentityNullifierPda(identityNullifier);
    const attestationNonceRegistryPda = deriveAttestationNoncePda(nonce);

    const attestationIx =
      anchor.web3.Ed25519Program.createInstructionWithPrivateKey({
        privateKey: verifier.secretKey,
        message: buildAttestationMessage(
          user.publicKey,
          proofHash,
          source,
          identityNullifier,
          nonce,
          baseScore,
          timestamp
        ),
      });

    await program.methods
      .submitProof(
        Array.from(proofHash),
        source,
        identityNullifier,
        new anchor.BN(nonce),
        proofData,
        baseScore,
        new anchor.BN(timestamp)
      )
      .preInstructions([attestationIx])
      .accountsStrict({
        registry: registryPda,
        userProof: userProofPda,
        individualProof: individualProofPda,
        identityNullifierRegistry: identityNullifierRegistryPda,
        attestationNonceRegistry: attestationNonceRegistryPda,
        scoringConfig: scoringConfigPda,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    return {
      userProofPda,
      individualProofPda,
      identityNullifierRegistryPda,
    };
  };

  describe("Initialization", () => {
    it("should initialize registry", async () => {
      await program.methods
        .initializeRegistry(
          new anchor.BN(100),
          new anchor.BN(0),
          10,
          new anchor.BN(3600),
          payer
        )
        .accountsStrict({
          registry: registryPda,
          authority: payer,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      const registry = await program.account.registry.fetch(registryPda);
      expect(registry.authority.toString()).to.equal(payer.toString());
      expect(registry.verifierAuthority.toString()).to.equal(payer.toString());
      expect(registry.minScore.toNumber()).to.equal(100);
      expect(registry.cooldownPeriod.toNumber()).to.equal(0);
      expect(registry.proofTtlSeconds.toNumber()).to.equal(3600);
      expect(registry.totalVerifiedUsers.toNumber()).to.equal(0);
    });

    it("should initialize scoring config", async () => {
      await program.methods
        .initializeScoringConfig()
        .accountsStrict({
          scoringConfig: scoringConfigPda,
          authority: payer,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      const scoringConfig = await program.account.scoringConfig.fetch(
        scoringConfigPda
      );

      expect(scoringConfig.authority.toString()).to.equal(payer.toString());
      expect(scoringConfig.weights.every((w) => w.toNumber() === 100)).to.equal(
        true
      );
    });
  });

  describe("Proof Submission", () => {
    it("should submit proof successfully", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const proofHash = Buffer.alloc(32, "proof1");
      const source = { reclaim: {} };
      const payload = sourceData("reclaim", now);

      const { userProofPda } = await submitProof(
        user,
        proofHash,
        source,
        payload,
        new anchor.BN(150),
        now
      );

      const userProof = await program.account.userProof.fetch(userProofPda);
      expect(userProof.user.toString()).to.equal(user.publicKey.toString());
      expect(userProof.activeSourceCount).to.equal(1);
      expect(userProof.aggregatedScore.toNumber()).to.be.greaterThan(0);
      expect(userProof.validUntil.toNumber()).to.be.greaterThan(now);
    });

    it("should allow duplicate proof hash with unique nonce", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const proofHash = Buffer.alloc(32, "proof2");
      const source = { gitcoinPassport: {} };
      const payload = sourceData("gitcoin", now, 200);

      await submitProof(
        user,
        proofHash,
        source,
        payload,
        new anchor.BN(200),
        now
      );

      await submitProof(
        user,
        proofHash,
        source,
        payload,
        new anchor.BN(200),
        now
      );
    });

    it("should reject invalid timestamp (future)", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const proofHash = Buffer.alloc(32, "proof3");
      const source = { worldId: {} };
      const payload = sourceData("worldId", now);

      try {
        await submitProof(
          user,
          proofHash,
          source,
          payload,
          new anchor.BN(150),
          now + 1000
        );
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("InvalidTimestamp");
      }
    });

    it("should reject mismatched source payload", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);

      try {
        await submitProof(
          user,
          Buffer.alloc(32, "proof3b"),
          { worldId: {} },
          sourceData("reclaim", now),
          new anchor.BN(150),
          now
        );
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("SourcePayloadMismatch");
      }
    });

    it("should reject unsupported source payload mappings", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);
      const now = Math.floor(Date.now() / 1000);
      const reclaimPayload = sourceData("reclaim", now);

      const unsupportedSources = [
        { brightId: {} },
        { lens: {} },
        { twitter: {} },
        { google: {} },
        { discord: {} },
      ];

      for (let i = 0; i < unsupportedSources.length; i += 1) {
        try {
          await submitProof(
            user,
            Buffer.from(Uint8Array.from([40 + i, ...Array(31).fill(0)])),
            unsupportedSources[i],
            reclaimPayload,
            new anchor.BN(140),
            now
          );
          expect.fail("should have thrown error");
        } catch (error: any) {
          expect(error.error.errorCode.code).to.equal("SourcePayloadMismatch");
        }
      }
    });

    it("should reject when ed25519 pre-instruction is missing", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);
      const now = Math.floor(Date.now() / 1000);
      const source = { reclaim: {} };
      const payload = sourceData("reclaim", now);
      const identityNullifier = identityNullifierFromPayload(source, payload);
      const nonce = 818181;

      const userProofPda = deriveUserProofPda(user.publicKey);
      const individualProofPda = deriveIndividualProofPda(
        user.publicKey,
        sourceIndex.reclaim
      );
      const identityNullifierRegistryPda =
        deriveIdentityNullifierPda(identityNullifier);
      const attestationNonceRegistryPda = deriveAttestationNoncePda(nonce);

      try {
        await program.methods
          .submitProof(
            Array.from(Buffer.alloc(32, "nosig")),
            source,
            identityNullifier,
            new anchor.BN(nonce),
            payload as any,
            new anchor.BN(150),
            new anchor.BN(now)
          )
          .accountsStrict({
            registry: registryPda,
            userProof: userProofPda,
            individualProof: individualProofPda,
            identityNullifierRegistry: identityNullifierRegistryPda,
            attestationNonceRegistry: attestationNonceRegistryPda,
            scoringConfig: scoringConfigPda,
            instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            user: user.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([user])
          .rpc();

        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal(
          "InvalidAttestationInstruction"
        );
      }
    });

    it("should reject duplicate identity nullifier across wallets", async () => {
      const userA = anchor.web3.Keypair.generate();
      const userB = anchor.web3.Keypair.generate();
      await airdrop(userA.publicKey);
      await airdrop(userB.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const source = { worldId: {} };
      const sharedPayload = sourceData("worldId", now);

      await submitProof(
        userA,
        Buffer.alloc(32, "proof3c"),
        source,
        sharedPayload,
        new anchor.BN(160),
        now
      );

      try {
        await submitProof(
          userB,
          Buffer.alloc(32, "proof3d"),
          source,
          sharedPayload,
          new anchor.BN(160),
          now
        );
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("DuplicateIdentityClaim");
      }
    });

    it("should reject reused attestation nonce", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const nonce = 999999;

      await submitProof(
        user,
        Buffer.alloc(32, "proof3e"),
        { reclaim: {} },
        sourceData("reclaim", now),
        new anchor.BN(170),
        now,
        nonce
      );

      try {
        await submitProof(
          user,
          Buffer.alloc(32, "proof3f"),
          { reclaim: {} },
          sourceData("reclaim", now),
          new anchor.BN(170),
          now,
          nonce
        );
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal(
          "AttestationNonceAlreadyUsed"
        );
      }
    });
  });

  describe("Proof Verification", () => {
    it("should verify proof successfully", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const source = { reclaim: {} };
      const payload = sourceData("reclaim", now);

      const { userProofPda } = await submitProof(
        user,
        Buffer.alloc(32, "proof4"),
        source,
        payload,
        new anchor.BN(200),
        now
      );

      const result = await program.methods
        .verifyProof()
        .accountsStrict({
          userProof: userProofPda,
          registry: registryPda,
          user: user.publicKey,
        })
        .view();

      expect(result.isVerified).to.equal(true);
    });

    it("should require renewal after ttl expiry", async () => {
      await program.methods
        .updateRegistryConfig(new anchor.BN(0), 10, new anchor.BN(1))
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);
      const now = Math.floor(Date.now() / 1000);

      const { userProofPda } = await submitProof(
        user,
        Buffer.alloc(32, "proof4b"),
        { reclaim: {} },
        sourceData("reclaim", now),
        new anchor.BN(250),
        now
      );

      await new Promise((resolve) => setTimeout(resolve, 2200));

      const result = await program.methods
        .verifyProof()
        .accountsStrict({
          userProof: userProofPda,
          registry: registryPda,
          user: user.publicKey,
        })
        .view();

      expect(result.isVerified).to.equal(false);

      await program.methods
        .updateRegistryConfig(new anchor.BN(0), 10, new anchor.BN(3600))
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();
    });
  });

  describe("Proof Revocation", () => {
    it("should revoke proof successfully", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const source = { gitcoinPassport: {} };
      const payload = sourceData("gitcoin", now, 200);

      const { userProofPda, individualProofPda, identityNullifierRegistryPda } =
        await submitProof(
          user,
          Buffer.alloc(32, "proof5"),
          source,
          payload,
          new anchor.BN(200),
          now
        );

      const before = await program.account.userProof.fetch(userProofPda);

      await program.methods
        .revokeProof(source)
        .accountsStrict({
          registry: registryPda,
          userProof: userProofPda,
          individualProof: individualProofPda,
          identityNullifierRegistry: identityNullifierRegistryPda,
          user: user.publicKey,
        })
        .signers([user])
        .rpc();

      const after = await program.account.userProof.fetch(userProofPda);
      expect(after.aggregatedScore.toNumber()).to.be.lessThan(
        before.aggregatedScore.toNumber()
      );
      expect(after.activeSourceCount).to.equal(0);
    });

    it("should reject revoke from mismatched signer", async () => {
      const owner = anchor.web3.Keypair.generate();
      const attacker = anchor.web3.Keypair.generate();
      await airdrop(owner.publicKey);

      const now = Math.floor(Date.now() / 1000);

      const { userProofPda, individualProofPda, identityNullifierRegistryPda } =
        await submitProof(
          owner,
          Buffer.alloc(32, "proof6"),
          { worldId: {} },
          sourceData("worldId", now),
          new anchor.BN(150),
          now
        );

      try {
        await program.methods
          .revokeProof({ worldId: {} })
          .accountsStrict({
            registry: registryPda,
            userProof: userProofPda,
            individualProof: individualProofPda,
            identityNullifierRegistry: identityNullifierRegistryPda,
            user: attacker.publicKey,
          })
          .signers([attacker])
          .rpc();
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("ConstraintSeeds");
      }
    });

    it("should permanently burn identity after revoke", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const source = { worldId: {} };
      const payload = sourceData("worldId", now);

      const { individualProofPda, userProofPda, identityNullifierRegistryPda } =
        await submitProof(
          user,
          Buffer.alloc(32, "burn1"),
          source,
          payload,
          new anchor.BN(180),
          now
        );

      await program.methods
        .revokeProof(source)
        .accountsStrict({
          registry: registryPda,
          userProof: userProofPda,
          individualProof: individualProofPda,
          identityNullifierRegistry: identityNullifierRegistryPda,
          user: user.publicKey,
        })
        .signers([user])
        .rpc();

      try {
        await submitProof(
          user,
          Buffer.alloc(32, "burn2"),
          source,
          payload,
          new anchor.BN(180),
          now
        );
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("IdentityRevokedPermanent");
      }
    });
  });

  describe("Admin Functions", () => {
    it("should update min score", async () => {
      await program.methods
        .updateMinScore(new anchor.BN(250))
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      const registry = await program.account.registry.fetch(registryPda);
      expect(registry.minScore.toNumber()).to.equal(250);
    });

    it("should update scoring config", async () => {
      await program.methods
        .updateScoringConfig({ reclaim: {} }, new anchor.BN(150))
        .accountsStrict({
          scoringConfig: scoringConfigPda,
          authority: payer,
        })
        .rpc();

      const scoringConfig = await program.account.scoringConfig.fetch(
        scoringConfigPda
      );
      expect(scoringConfig.weights[0].toNumber()).to.equal(150);
    });

    it("should update registry config", async () => {
      await program.methods
        .updateRegistryConfig(new anchor.BN(0), 20, new anchor.BN(3600))
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      const registry = await program.account.registry.fetch(registryPda);
      expect(registry.cooldownPeriod.toNumber()).to.equal(0);
      expect(registry.diversityBonusPercent).to.equal(20);
      expect(registry.proofTtlSeconds.toNumber()).to.equal(3600);
      expect(registry.verifierAuthority.toString()).to.equal(payer.toString());
    });

    it("should reject finalize when no verifier rotation pending", async () => {
      try {
        await program.methods
          .finalizeVerifierRotation()
          .accountsStrict({
            registry: registryPda,
            authority: payer,
          })
          .rpc();
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal(
          "NoVerifierRotationPending"
        );
      }
    });

    it("should reject invalid verifier rotation params", async () => {
      try {
        await program.methods
          .initiateVerifierRotation(
            anchor.web3.PublicKey.default,
            new anchor.BN(1)
          )
          .accountsStrict({
            registry: registryPda,
            authority: payer,
          })
          .rpc();
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("InvalidConfig");
      }

      try {
        await program.methods
          .initiateVerifierRotation(payer, new anchor.BN(0))
          .accountsStrict({
            registry: registryPda,
            authority: payer,
          })
          .rpc();
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("InvalidConfig");
      }
    });

    it("should reject finalize before rotation delay elapses", async () => {
      const newVerifier = anchor.web3.Keypair.generate();

      await program.methods
        .initiateVerifierRotation(newVerifier.publicKey, new anchor.BN(2))
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      try {
        await program.methods
          .finalizeVerifierRotation()
          .accountsStrict({
            registry: registryPda,
            authority: payer,
          })
          .rpc();
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("VerifierRotationNotReady");
      }

      await new Promise((resolve) => setTimeout(resolve, 2500));

      await program.methods
        .finalizeVerifierRotation()
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      await program.methods
        .initiateVerifierRotation(payer, new anchor.BN(1))
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      await new Promise((resolve) => setTimeout(resolve, 2500));

      await program.methods
        .finalizeVerifierRotation()
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();
    });

    it("should rotate verifier authority with delay", async () => {
      const newVerifier = anchor.web3.Keypair.generate();

      await program.methods
        .initiateVerifierRotation(newVerifier.publicKey, new anchor.BN(1))
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      await new Promise((resolve) => setTimeout(resolve, 2500));

      await program.methods
        .finalizeVerifierRotation()
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      const registry = await program.account.registry.fetch(registryPda);
      expect(registry.verifierAuthority.toString()).to.equal(
        newVerifier.publicKey.toString()
      );
    });

    it("should reject old verifier signature after rotation", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const proofHash = Buffer.alloc(32, "oldver");
      const source = { reclaim: {} };
      const payload = sourceData("reclaim", now);
      const identityNullifier = identityNullifierFromPayload(source, payload);
      const nonce = 424242;

      const attestationIx =
        anchor.web3.Ed25519Program.createInstructionWithPrivateKey({
          privateKey: verifier.secretKey,
          message: buildAttestationMessage(
            user.publicKey,
            proofHash,
            source,
            identityNullifier,
            nonce,
            new anchor.BN(150),
            now
          ),
        });

      const userProofPda = deriveUserProofPda(user.publicKey);
      const individualProofPda = deriveIndividualProofPda(
        user.publicKey,
        sourceIndex.reclaim
      );
      const identityNullifierRegistryPda =
        deriveIdentityNullifierPda(identityNullifier);
      const attestationNonceRegistryPda = deriveAttestationNoncePda(nonce);

      try {
        await program.methods
          .submitProof(
            Array.from(proofHash),
            source,
            identityNullifier,
            new anchor.BN(nonce),
            payload as any,
            new anchor.BN(150),
            new anchor.BN(now)
          )
          .preInstructions([attestationIx])
          .accountsStrict({
            registry: registryPda,
            userProof: userProofPda,
            individualProof: individualProofPda,
            identityNullifierRegistry: identityNullifierRegistryPda,
            attestationNonceRegistry: attestationNonceRegistryPda,
            scoringConfig: scoringConfigPda,
            instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            user: user.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([user])
          .rpc();

        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal(
          "InvalidAttestationMessage"
        );
      }

      await program.methods
        .initiateVerifierRotation(payer, new anchor.BN(1))
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      await new Promise((resolve) => setTimeout(resolve, 2500));

      await program.methods
        .finalizeVerifierRotation()
        .accountsStrict({
          registry: registryPda,
          authority: payer,
        })
        .rpc();
    });

    it("should reject unauthorized update", async () => {
      const unauthorized = anchor.web3.Keypair.generate();
      try {
        await program.methods
          .updateMinScore(new anchor.BN(300))
          .accountsStrict({
            registry: registryPda,
            authority: unauthorized.publicKey,
          })
          .signers([unauthorized])
          .rpc();
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("Unauthorized");
      }
    });
  });

  describe("Complex Scenarios", () => {
    it("should apply diversity bonus with multiple sources", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);
      const now = Math.floor(Date.now() / 1000);

      const userProofPda = deriveUserProofPda(user.publicKey);

      await submitProof(
        user,
        Buffer.from(Uint8Array.from([100, ...Array(31).fill(0)])),
        { reclaim: {} },
        sourceData("reclaim", now),
        new anchor.BN(100),
        now
      );

      await submitProof(
        user,
        Buffer.from(Uint8Array.from([101, ...Array(31).fill(0)])),
        { gitcoinPassport: {} },
        sourceData("gitcoin", now, 100),
        new anchor.BN(100),
        now
      );

      const userProof = await program.account.userProof.fetch(userProofPda);
      expect(userProof.activeSourceCount).to.equal(2);
      expect(userProof.aggregatedScore.toNumber()).to.be.greaterThan(200);
    });

    it("should reject expired proof timestamp", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const oldTimestamp = Math.floor(Date.now() / 1000) - 7200;

      try {
        await submitProof(
          user,
          Buffer.alloc(32, "proof7"),
          { reclaim: {} },
          sourceData("reclaim", oldTimestamp),
          new anchor.BN(100),
          oldTimestamp
        );
        expect.fail("should have thrown error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("ProofExpired");
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle score overflow safely", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const massiveScore = new anchor.BN(2).pow(new anchor.BN(60));

      try {
        await submitProof(
          user,
          Buffer.alloc(32, "proof8"),
          { reclaim: {} },
          sourceData("reclaim", now),
          massiveScore,
          now
        );
        expect.fail("should have thrown overflow error");
      } catch (error: any) {
        expect(error.error.errorCode.code).to.equal("Overflow");
      }
    });

    it("should verify proof status correctly", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(user.publicKey);

      const now = Math.floor(Date.now() / 1000);
      const { userProofPda } = await submitProof(
        user,
        Buffer.alloc(32, "proof9"),
        { gitcoinPassport: {} },
        sourceData("gitcoin", now, 300),
        new anchor.BN(300),
        now
      );

      const result = await program.methods
        .verifyProof()
        .accountsStrict({
          userProof: userProofPda,
          registry: registryPda,
          user: user.publicKey,
        })
        .view();

      expect(result.isVerified).to.equal(true);
      expect(result.verifiedAt.toNumber()).to.be.greaterThan(0);
    });
  });
});
