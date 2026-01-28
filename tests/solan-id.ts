import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { SolanId } from "../target/types/solan_id";

describe("SolanID", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanId as Program<SolanId>;
  const payer = provider.wallet.publicKey;

  let registryPda: anchor.web3.PublicKey;
  let scoringConfigPda: anchor.web3.PublicKey;
  let user: anchor.web3.Keypair;

  const [registryBump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("registry")],
    program.programId
  );

  const [scoringConfigBump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("scoring_config")],
    program.programId
  );

  before(async () => {
    registryPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("registry")],
      program.programId
    )[0];

    scoringConfigPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("scoring_config")],
      program.programId
    )[0];

    user = anchor.web3.Keypair.generate();
  });

  describe("Initialization", () => {
    it("should initialize registry", async () => {
      const minScore = new anchor.BN(100);
      const cooldownPeriod = new anchor.BN(86400);
      const diversityBonusPercent = 10;

      await program.methods
        .initializeRegistry(minScore, cooldownPeriod, diversityBonusPercent)
        .accountsStrict ({
          registry: registryPda,
          authority: payer,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      const registry = await program.account.registry.fetch(registryPda);

      expect(registry.authority.toString()).to.equal(payer.toString());
      expect(registry.minScore.toNumber()).to.equal(100);
      expect(registry.cooldownPeriod.toNumber()).to.equal(86400);
      expect(registry.diversityBonusPercent).to.equal(10);
      expect(registry.totalVerifiedUsers.toNumber()).to.equal(0);
    });

    it("should initialize scoring config", async () => {
      await program.methods
        .initializeScoringConfig()
        .accountsStrict ({
          scoringConfig: scoringConfigPda,
          authority: payer,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      const scoringConfig = await program.account.scoringConfig.fetch(
        scoringConfigPda
      );

      expect(scoringConfig.authority.toString()).to.equal(payer.toString());
      expect(scoringConfig.weights.every((w) => w.toNumber() === 100)).to.be
        .true;
    });
  });

  describe("Proof Submission", () => {
    it("should submit proof successfully", async () => {
      const proofHash = Buffer.alloc(32, "proof1");
      const baseScore = new anchor.BN(150);
      const source = { reclaim: {} };
      const timestamp = Math.floor(Date.now() / 1000);

      const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_proof"), user.publicKey.toBuffer()],
        program.programId
      )[0];

      const individualProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("individual_proof"), user.publicKey.toBuffer(), Buffer.from([0])],
        program.programId
      )[0];

      const proofHashRegistryPda =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("proof_hash"), proofHash],
          program.programId
        )[0];

      await program.methods
        .submitProof(Array.from(proofHash), baseScore, source, new anchor.BN(timestamp))
        .accountsStrict ({
          registry: registryPda,
          userProof: userProofPda,
          individualProof: individualProofPda,
          proofHashRegistry: proofHashRegistryPda,
          scoringConfig: scoringConfigPda,
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userProof = await program.account.userProof.fetch(userProofPda);

      expect(userProof.user.toString()).to.equal(user.publicKey.toString());
      expect(userProof.activeSourceCount).to.equal(1);
      expect(userProof.aggregatedScore.toNumber()).to.be.greaterThan(0);
    });

    it("should reject duplicate proof hash", async () => {
      const proofHash = Buffer.alloc(32, "proof2");
      const baseScore = new anchor.BN(200);
      const source = { gitcoinPassport: {} };
      const timestamp = Math.floor(Date.now() / 1000);

      const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_proof"), user.publicKey.toBuffer()],
        program.programId
      )[0];

      const individualProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("individual_proof"), user.publicKey.toBuffer(), Buffer.from([1])],
        program.programId
      )[0];

      const proofHashRegistryPda =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("proof_hash"), proofHash],
          program.programId
        )[0];

      await program.methods
        .submitProof(Array.from(proofHash), baseScore, source, new anchor.BN(timestamp))
        .accountsStrict ({
          registry: registryPda,
          userProof: userProofPda,
          individualProof: individualProofPda,
          proofHashRegistry: proofHashRegistryPda,
          scoringConfig: scoringConfigPda,
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      try {
        await program.methods
          .submitProof(Array.from(proofHash), baseScore, source, new anchor.BN(timestamp))
          .accountsStrict({
            registry: registryPda,
            userProof: userProofPda,
            individualProof: individualProofPda,
            proofHashRegistry: proofHashRegistryPda,
            scoringConfig: scoringConfigPda,
            user: user.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([user])
          .rpc();

        expect.fail("should have thrown error");
      } catch (error) {
        expect(error.error.errorCode.code).to.equal("ProofHashAlreadyUsed");
      }
    });

    it("should reject invalid timestamp (future)", async () => {
      const proofHash = Buffer.alloc(32, "proof3");
      const baseScore = new anchor.BN(150);
      const source = { worldId: {} };
      const futureTimestamp = Math.floor(Date.now() / 1000) + 1000;

      const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_proof"), user.publicKey.toBuffer()],
        program.programId
      )[0];

      const individualProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("individual_proof"), user.publicKey.toBuffer(), Buffer.from([2])],
        program.programId
      )[0];

      const proofHashRegistryPda =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("proof_hash"), proofHash],
          program.programId
        )[0];

      try {
        await program.methods
          .submitProof(
            Array.from(proofHash),
            baseScore,
            source,
            new anchor.BN(futureTimestamp)
          )
          .accountsStrict({
            registry: registryPda,
            userProof: userProofPda,
            individualProof: individualProofPda,
            proofHashRegistry: proofHashRegistryPda,
            scoringConfig: scoringConfigPda,
            user: user.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([user])
          .rpc();

        expect.fail("should have thrown error");
      } catch (error) {
        expect(error.error.errorCode.code).to.equal("InvalidTimestamp");
      }
    });
  });

  describe("Proof Verification", () => {
    it("should verify proof successfully", async () => {
      const user2 = anchor.web3.Keypair.generate();
      const proofHash = Buffer.alloc(32, "proof4");
      const baseScore = new anchor.BN(150);
      const source = { reclaim: {} };
      const timestamp = Math.floor(Date.now() / 1000);

      const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_proof"), user2.publicKey.toBuffer()],
        program.programId
      )[0];

      const individualProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("individual_proof"), user2.publicKey.toBuffer(), Buffer.from([0])],
        program.programId
      )[0];

      const proofHashRegistryPda =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("proof_hash"), proofHash],
          program.programId
        )[0];

      await program.methods
        .submitProof(Array.from(proofHash), baseScore, source, new anchor.BN(timestamp))
        .accountsStrict({
          registry: registryPda,
          userProof: userProofPda,
          individualProof: individualProofPda,
          proofHashRegistry: proofHashRegistryPda,
          scoringConfig: scoringConfigPda,
          user: user2.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      const result = await program.methods
        .verifyProof()
        .accountsStrict({
          userProof: userProofPda,
          registry: registryPda,
          user: user2.publicKey,
        })
        .view();

      expect(result.isVerified).to.be.true;
      expect(result.aggregatedScore.toNumber()).to.be.greaterThan(0);
    });
  });

  describe("Proof Revocation", () => {
    it("should revoke proof successfully", async () => {
      const user3 = anchor.web3.Keypair.generate();
      const proofHash = Buffer.alloc(32, "proof5");
      const baseScore = new anchor.BN(200);
      const source = { gitcoinPassport: {} };
      const timestamp = Math.floor(Date.now() / 1000);

      const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_proof"), user3.publicKey.toBuffer()],
        program.programId
      )[0];

      const individualProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("individual_proof"), user3.publicKey.toBuffer(), Buffer.from([1])],
        program.programId
      )[0];

      const proofHashRegistryPda =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("proof_hash"), proofHash],
          program.programId
        )[0];

      await program.methods
        .submitProof(Array.from(proofHash), baseScore, source, new anchor.BN(timestamp))
        .accountsStrict({
          registry: registryPda,
          userProof: userProofPda,
          individualProof: individualProofPda,
          proofHashRegistry: proofHashRegistryPda,
          scoringConfig: scoringConfigPda,
          user: user3.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user3])
        .rpc();

      const userProofBefore = await program.account.userProof.fetch(
        userProofPda
      );
      const scoreBefore = userProofBefore.aggregatedScore.toNumber();

      await program.methods
        .revokeProof(source)
        .accountsStrict({
          registry: registryPda,
          userProof: userProofPda,
          individualProof: individualProofPda,
          user: user3.publicKey,
        })
        .signers([user3])
        .rpc();

      const userProofAfter = await program.account.userProof.fetch(
        userProofPda
      );
      const scoreAfter = userProofAfter.aggregatedScore.toNumber();

      expect(scoreAfter).to.be.lessThan(scoreBefore);
      expect(userProofAfter.activeSourceCount).to.equal(0);
    });

    it("should reject revoke from unauthorized user", async () => {
      const user4 = anchor.web3.Keypair.generate();
      const user5 = anchor.web3.Keypair.generate();
      const proofHash = Buffer.alloc(32, "proof6");
      const baseScore = new anchor.BN(150);
      const source = { worldId: {} };
      const timestamp = Math.floor(Date.now() / 1000);

      const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_proof"), user4.publicKey.toBuffer()],
        program.programId
      )[0];

      const individualProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("individual_proof"), user4.publicKey.toBuffer(), Buffer.from([2])],
        program.programId
      )[0];

      const proofHashRegistryPda =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("proof_hash"), proofHash],
          program.programId
        )[0];

      await program.methods
        .submitProof(Array.from(proofHash), baseScore, source, new anchor.BN(timestamp))
        .accountsStrict({
          registry: registryPda,
          userProof: userProofPda,
          individualProof: individualProofPda,
          proofHashRegistry: proofHashRegistryPda,
          scoringConfig: scoringConfigPda,
          user: user4.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user4])
        .rpc();

      try {
        await program.methods
          .revokeProof(source)
          .accountsStrict({
            registry: registryPda,
            userProof: userProofPda,
            individualProof: individualProofPda,
            user: user5.publicKey,
          })
          .signers([user5])
          .rpc();

        expect.fail("should have thrown error");
      } catch (error) {
        expect(error.error.errorCode.code).to.equal("Unauthorized");
      }
    });
  });

  describe("Admin Functions", () => {
    it("should update min score", async () => {
      const newMinScore = new anchor.BN(250);

      await program.methods
        .updateMinScore(newMinScore)
        .accounts({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      const registry = await program.account.registry.fetch(registryPda);
      expect(registry.minScore.toNumber()).to.equal(250);
    });

    it("should update scoring config", async () => {
      const source = { reclaim: {} };
      const newWeight = new anchor.BN(150);

      await program.methods
        .updateScoringConfig(source, newWeight)
        .accounts({
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
      const newCooldown = new anchor.BN(172800);
      const newDiversityBonus = 20;

      await program.methods
        .updateRegistryConfig(newCooldown, newDiversityBonus)
        .accounts({
          registry: registryPda,
          authority: payer,
        })
        .rpc();

      const registry = await program.account.registry.fetch(registryPda);
      expect(registry.cooldownPeriod.toNumber()).to.equal(172800);
      expect(registry.diversityBonusPercent).to.equal(20);
    });

    it("should reject unauthorized update", async () => {
      const unauthorized = anchor.web3.Keypair.generate();
      const newMinScore = new anchor.BN(300);

      try {
        await program.methods
          .updateMinScore(newMinScore)
          .accounts({
            registry: registryPda,
            authority: unauthorized.publicKey,
          })
          .signers([unauthorized])
          .rpc();

        expect.fail("should have thrown error");
      } catch (error) {
        expect(error.error.errorCode.code).to.equal("Unauthorized");
      }
    });
  });

  describe("Complex Scenarios", () => {
    it("should apply diversity bonus with multiple sources", async () => {
      const user6 = anchor.web3.Keypair.generate();
      const timestamp = Math.floor(Date.now() / 1000);

      const sources: Array<{ reclaim: {} } | { gitcoinPassport: {} }> = [
        { reclaim: {} },
        { gitcoinPassport: {} },
      ];

      for (let i = 0; i < sources.length; i++) {
        const proofHash = Buffer.alloc(32);
        proofHash[0] = i + 100;

        const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("user_proof"), user6.publicKey.toBuffer()],
          program.programId
        )[0];

        const individualProofPda = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("individual_proof"),
            user6.publicKey.toBuffer(),
            Buffer.from([i]),
          ],
          program.programId
        )[0];

        const proofHashRegistryPda =
          anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("proof_hash"), proofHash],
            program.programId
          )[0];

        const source = i === 0 ? { reclaim: {} } : { gitcoinPassport: {} };
        await program.methods
          .submitProof(
            Array.from(proofHash),
            new anchor.BN(100),
            source as any,
            new anchor.BN(timestamp)
          )
          .accountsStrict({
            registry: registryPda,
            userProof: userProofPda,
            individualProof: individualProofPda,
            proofHashRegistry: proofHashRegistryPda,
            scoringConfig: scoringConfigPda,
            user: user6.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([user6])
          .rpc();
      }

      const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_proof"), user6.publicKey.toBuffer()],
        program.programId
      )[0];

      const userProof = await program.account.userProof.fetch(userProofPda);
      expect(userProof.activeSourceCount).to.equal(2);
      expect(userProof.aggregatedScore.toNumber()).to.be.greaterThan(200);
    });

    it("should handle recency factor decay", async () => {
      const user7 = anchor.web3.Keypair.generate();
      const oldTimestamp = Math.floor(Date.now() / 1000) - 60000000;
      const proofHash = Buffer.alloc(32, "proof7");
      const baseScore = new anchor.BN(100);
      const source = { reclaim: {} };

      const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_proof"), user7.publicKey.toBuffer()],
        program.programId
      )[0];

      const individualProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("individual_proof"), user7.publicKey.toBuffer(), Buffer.from([0])],
        program.programId
      )[0];

      const proofHashRegistryPda =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("proof_hash"), proofHash],
          program.programId
        )[0];

      await program.methods
        .submitProof(
          Array.from(proofHash),
          baseScore,
          source,
          new anchor.BN(oldTimestamp)
        )
        .accountsStrict({
          registry: registryPda,
          userProof: userProofPda,
          individualProof: individualProofPda,
          proofHashRegistry: proofHashRegistryPda,
          scoringConfig: scoringConfigPda,
          user: user7.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user7])
        .rpc();

      const userProof = await program.account.userProof.fetch(userProofPda);
      expect(userProof.aggregatedScore.toNumber()).to.be.lessThan(100);
    });
  });

  describe("Edge Cases", () => {
    it("should handle score overflow safely", async () => {
      const user8 = anchor.web3.Keypair.generate();
      const proofHash = Buffer.alloc(32, "proof8");
      const massiveScore = new anchor.BN(2).pow(new anchor.BN(60));
      const source = { reclaim: {} };
      const timestamp = Math.floor(Date.now() / 1000);

      const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_proof"), user8.publicKey.toBuffer()],
        program.programId
      )[0];

      const individualProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("individual_proof"), user8.publicKey.toBuffer(), Buffer.from([0])],
        program.programId
      )[0];

      const proofHashRegistryPda =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("proof_hash"), proofHash],
          program.programId
        )[0];

      try {
        await program.methods
          .submitProof(
            Array.from(proofHash),
            massiveScore,
            source,
            new anchor.BN(timestamp)
          )
          .accountsStrict ({
            registry: registryPda,
            userProof: userProofPda,
            individualProof: individualProofPda,
            proofHashRegistry: proofHashRegistryPda,
            scoringConfig: scoringConfigPda,
            user: user8.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([user8])
          .rpc();

        expect.fail("should have thrown overflow error");
      } catch (error) {
        expect(error.error.errorCode.code).to.equal("Overflow");
      }
    });

    it("should verify proof status correctly", async () => {
      const user9 = anchor.web3.Keypair.generate();
      const proofHash = Buffer.alloc(32, "proof9");
      const baseScore = new anchor.BN(150);
      const source = { gitcoinPassport: {} };
      const timestamp = Math.floor(Date.now() / 1000);

      const userProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_proof"), user9.publicKey.toBuffer()],
        program.programId
      )[0];

      const individualProofPda = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("individual_proof"), user9.publicKey.toBuffer(), Buffer.from([1])],
        program.programId
      )[0];

      const proofHashRegistryPda =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("proof_hash"), proofHash],
          program.programId
        )[0];

      await program.methods
        .submitProof(
          Array.from(proofHash),
          baseScore,
          source,
          new anchor.BN(timestamp)
        )
        .accountsStrict({
          registry: registryPda,
          userProof: userProofPda,
          individualProof: individualProofPda,
          proofHashRegistry: proofHashRegistryPda,
          scoringConfig: scoringConfigPda,
          user: user9.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user9])
        .rpc();

      const result = await program.methods
        .verifyProof()
        .accountsStrict({
          userProof: userProofPda,
          registry: registryPda,
          user: user9.publicKey,
        })
        .view();

      expect(result.isVerified).to.be.true;
      expect(result.verifiedAt).to.equal(timestamp);
    });
  });
});