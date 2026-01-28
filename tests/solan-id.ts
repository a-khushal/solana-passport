import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanId } from "../target/types/solan_id";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("solan-id", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.solanId as Program<SolanId>;
  const provider = anchor.AnchorProvider.env();

  const [registryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("registry")],
    program.programId
  );

  const [scoringConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("scoring_config")],
    program.programId
  );

  const getUserProofPda = (user: PublicKey) => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user_proof"), user.toBuffer()],
      program.programId
    );
  };

  it("Initializes registry", async () => {
    const minScore = new anchor.BN(50);

    const tx = await program.methods
      .initializeRegistry(minScore)
      .accounts({
        registry: registryPda,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Initialize registry transaction signature", tx);

    const registry = await program.account.registry.fetch(registryPda);
    expect(registry.totalVerifiedUsers.toNumber()).to.equal(0);
    expect(registry.minScore.toNumber()).to.equal(50);
    expect(registry.authority.toString()).to.equal(
      provider.wallet.publicKey.toString()
    );
  });

  it("Initializes scoring config", async () => {
    const tx = await program.methods
      .initializeScoringConfig()
      .accounts({
        scoringConfig: scoringConfigPda,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Initialize scoring config transaction signature", tx);

    const scoringConfig = await program.account.scoringConfig.fetch(
      scoringConfigPda
    );
    expect(scoringConfig.weights.length).to.equal(8);
    expect(scoringConfig.weights[0].toNumber()).to.equal(100);
  });

  it("Submits a proof with Reclaim source", async () => {
    const user = provider.wallet.publicKey;
    const [userProofPda] = getUserProofPda(user);

    const proofHash = Array.from(
      anchor.utils.sha256.hash("test-proof-data-reclaim")
    ).slice(0, 32) as number[];

    const source = { reclaim: {} };
    const score = new anchor.BN(100);
    const timestamp = new anchor.BN(Math.floor(Date.now() / 1000));

    const tx = await program.methods
      .submitProof(proofHash, score, source, timestamp)
      .accounts({
        registry: registryPda,
        userProof: userProofPda,
        user: user,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Submit proof transaction signature", tx);

    const userProof = await program.account.userProof.fetch(userProofPda);
    expect(userProof.user.toString()).to.equal(user.toString());
    expect(userProof.score.toNumber()).to.equal(100);
    expect(userProof.source.reclaim).to.exist;

    const registry = await program.account.registry.fetch(registryPda);
    expect(registry.totalVerifiedUsers.toNumber()).to.equal(1);
  });

  it("Updates an existing proof", async () => {
    const user = provider.wallet.publicKey;
    const [userProofPda] = getUserProofPda(user);

    const proofHash = Array.from(
      anchor.utils.sha256.hash("updated-proof-data")
    ).slice(0, 32) as number[];

    const source = { gitcoinPassport: {} };
    const score = new anchor.BN(150);
    const timestamp = new anchor.BN(Math.floor(Date.now() / 1000));

    const tx = await program.methods
      .updateProof(proofHash, score, source, timestamp)
      .accounts({
        registry: registryPda,
        userProof: userProofPda,
        user: user,
      })
      .rpc();

    console.log("Update proof transaction signature", tx);

    const userProof = await program.account.userProof.fetch(userProofPda);
    expect(userProof.score.toNumber()).to.equal(150);
    expect(userProof.source.gitcoinPassport).to.exist;

    const registry = await program.account.registry.fetch(registryPda);
    expect(registry.totalVerifiedUsers.toNumber()).to.equal(1);
  });

  it("Verifies a proof", async () => {
    const user = provider.wallet.publicKey;
    const [userProofPda] = getUserProofPda(user);

    const result = await program.methods
      .verifyProof()
      .accounts({
        userProof: userProofPda,
        user: user,
      })
      .view();

    expect(result.isVerified).to.be.true;
    expect(result.score.toNumber()).to.equal(150);
    expect(result.source.gitcoinPassport).to.exist;
    expect(result.verifiedAt.toNumber()).to.be.greaterThan(0);
  });

  it("Updates minimum score", async () => {
    const newMinScore = new anchor.BN(75);

    const registryBefore = await program.account.registry.fetch(registryPda);
    const oldMinScore = registryBefore.minScore.toNumber();

    const tx = await program.methods
      .updateMinScore(newMinScore)
      .accounts({
        registry: registryPda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    console.log("Update min score transaction signature", tx);

    const registry = await program.account.registry.fetch(registryPda);
    expect(registry.minScore.toNumber()).to.equal(75);
    expect(registry.minScore.toNumber()).to.not.equal(oldMinScore);
  });

  it("Updates scoring config for a source", async () => {
    const source = { reclaim: {} };
    const newWeight = new anchor.BN(120);

    const scoringConfigBefore = await program.account.scoringConfig.fetch(
      scoringConfigPda
    );
    const oldWeight = scoringConfigBefore.weights[0].toNumber();

    const tx = await program.methods
      .updateScoringConfig(source, newWeight)
      .accounts({
        scoringConfig: scoringConfigPda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    console.log("Update scoring config transaction signature", tx);

    const scoringConfig = await program.account.scoringConfig.fetch(
      scoringConfigPda
    );
    expect(scoringConfig.weights[0].toNumber()).to.equal(120);
    expect(scoringConfig.weights[0].toNumber()).to.not.equal(oldWeight);
  });

  it("Fails to submit proof with score below threshold", async () => {
    const user = anchor.web3.Keypair.generate();
    const [userProofPda] = getUserProofPda(user.publicKey);

    const airdropSig = await provider.connection.requestAirdrop(
      user.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    const proofHash = Array.from(
      anchor.utils.sha256.hash("low-score-proof")
    ).slice(0, 32) as number[];

    const source = { twitter: {} };
    const score = new anchor.BN(30);
    const timestamp = new anchor.BN(Math.floor(Date.now() / 1000));

    try {
      await program.methods
        .submitProof(proofHash, score, source, timestamp)
        .accounts({
          registry: registryPda,
          userProof: userProofPda,
          user: user.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (err: any) {
      const errorCode = err.error?.errorCode?.code || err.error?.errorCode?.number;
      expect(errorCode).to.equal("ScoreBelowThreshold");
    }
  });

  it("Submits proof with WorldId source", async () => {
    const user = anchor.web3.Keypair.generate();
    const [userProofPda] = getUserProofPda(user.publicKey);

    const airdropSig = await provider.connection.requestAirdrop(
      user.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    const proofHash = Array.from(
      anchor.utils.sha256.hash("worldid-proof-data")
    ).slice(0, 32) as number[];

    const source = { worldId: {} };
    const score = new anchor.BN(200);
    const timestamp = new anchor.BN(Math.floor(Date.now() / 1000));

    const tx = await program.methods
      .submitProof(proofHash, score, source, timestamp)
      .accounts({
        registry: registryPda,
        userProof: userProofPda,
        user: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    console.log("Submit WorldId proof transaction signature", tx);

    const userProof = await program.account.userProof.fetch(userProofPda);
    expect(userProof.user.toString()).to.equal(user.publicKey.toString());
    expect(userProof.score.toNumber()).to.equal(200);
    expect(userProof.source.worldId).to.exist;

    const registry = await program.account.registry.fetch(registryPda);
    expect(registry.totalVerifiedUsers.toNumber()).to.equal(2);
  });
});
