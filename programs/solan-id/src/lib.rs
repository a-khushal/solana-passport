use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use std::str::FromStr;

declare_id!("FGoa1MtyJRXew4FKdCSAMFfLEK7Y2GMfSjc2NsPrmX9p");

#[program]
pub mod solan_id {
    use super::*;

    pub fn initialize_registry(
        ctx: Context<InitializeRegistry>,
        min_score: u64,
        cooldown_period: i64,
        diversity_bonus_percent: u8,
        proof_ttl_seconds: i64,
        verifier_authority: Pubkey,
    ) -> Result<()> {
        require!(cooldown_period >= 0, SolanIdError::InvalidConfig);
        require!(diversity_bonus_percent <= 100, SolanIdError::InvalidConfig);
        require!(proof_ttl_seconds > 0, SolanIdError::InvalidConfig);
        require!(
            verifier_authority != Pubkey::default(),
            SolanIdError::InvalidConfig
        );

        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.total_verified_users = 0;
        registry.min_score = min_score;
        registry.cooldown_period = cooldown_period;
        registry.diversity_bonus_percent = diversity_bonus_percent;
        registry.proof_ttl_seconds = proof_ttl_seconds;
        registry.verifier_authority = verifier_authority;
        registry.pending_verifier_authority = Pubkey::default();
        registry.verifier_rotation_available_at = 0;
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    pub fn submit_proof(
        ctx: Context<SubmitProof>,
        proof_hash: [u8; 32],
        source: ProofSource,
        identity_nullifier: [u8; 32],
        attestation_nonce: u64,
        proof_data: SourceProofData,
        base_score: u64,
        timestamp: i64,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let user_proof = &mut ctx.accounts.user_proof;
        let individual_proof = &mut ctx.accounts.individual_proof;
        let identity_nullifier_registry = &mut ctx.accounts.identity_nullifier_registry;
        let attestation_nonce_registry = &mut ctx.accounts.attestation_nonce_registry;
        let scoring_config = &ctx.accounts.scoring_config;
        let clock = Clock::get()?;

        verify_verifier_attestation(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            ctx.program_id,
            registry.key(),
            ctx.accounts.user.key(),
            proof_hash,
            source,
            identity_nullifier,
            attestation_nonce,
            base_score,
            timestamp,
            registry.verifier_authority,
        )?;

        validate_source_proof_data(source, &proof_data, base_score, clock.unix_timestamp)?;

        require!(
            !attestation_nonce_registry.is_used,
            SolanIdError::AttestationNonceAlreadyUsed
        );

        require!(
            identity_nullifier == extract_identity_nullifier(source, &proof_data)?,
            SolanIdError::InvalidIdentityNullifier
        );

        if identity_nullifier_registry.claimed_by == Pubkey::default() {
            identity_nullifier_registry.nullifier = identity_nullifier;
            identity_nullifier_registry.source = source;
            identity_nullifier_registry.claimed_by = ctx.accounts.user.key();
            identity_nullifier_registry.is_burned = false;
            identity_nullifier_registry.claimed_at = clock.unix_timestamp;
            identity_nullifier_registry.last_proof_hash = proof_hash;
            identity_nullifier_registry.bump = ctx.bumps.identity_nullifier_registry;
        } else {
            require!(
                identity_nullifier_registry.source == source,
                SolanIdError::InvalidIdentityNullifier
            );
            require!(
                identity_nullifier_registry.nullifier == identity_nullifier,
                SolanIdError::InvalidIdentityNullifier
            );
            require!(
                identity_nullifier_registry.claimed_by == ctx.accounts.user.key(),
                SolanIdError::DuplicateIdentityClaim
            );
            require!(
                !identity_nullifier_registry.is_burned,
                SolanIdError::IdentityRevokedPermanent
            );
            identity_nullifier_registry.last_proof_hash = proof_hash;
        }

        require!(
            timestamp <= clock.unix_timestamp + 300,
            SolanIdError::InvalidTimestamp
        );

        require!(
            timestamp >= clock.unix_timestamp - registry.proof_ttl_seconds,
            SolanIdError::ProofExpired
        );

        if user_proof.user != Pubkey::default() {
            require!(
                clock.unix_timestamp
                    >= user_proof
                        .last_submission
                        .checked_add(registry.cooldown_period)
                        .ok_or(SolanIdError::Overflow)?,
                SolanIdError::CooldownPeriodActive
            );
        }

        let weight = scoring_config.weights[source as u8 as usize];
        let weighted_score = base_score
            .checked_mul(weight)
            .and_then(|s| s.checked_div(100))
            .ok_or(SolanIdError::Overflow)?;

        let age_seconds = clock.unix_timestamp.checked_sub(timestamp).unwrap_or(0);
        let recency_factor = if age_seconds < 2592000 {
            100u8
        } else if age_seconds < 7776000 {
            75u8
        } else if age_seconds < 15552000 {
            50u8
        } else {
            25u8
        };
        let recency_adjusted_score = weighted_score
            .checked_mul(recency_factor as u64)
            .and_then(|s| s.checked_div(100))
            .ok_or(SolanIdError::Overflow)?;

        let old_base_aggregated_score = strip_diversity_bonus(
            user_proof.aggregated_score,
            user_proof.active_source_count,
            registry.diversity_bonus_percent,
        )?;

        let old_score =
            if individual_proof.user != Pubkey::default() && !individual_proof.is_revoked {
                let age_seconds = clock
                    .unix_timestamp
                    .checked_sub(individual_proof.verified_at)
                    .unwrap_or(0);
                let recency = if age_seconds < 2592000 {
                    100u8
                } else if age_seconds < 7776000 {
                    75u8
                } else if age_seconds < 15552000 {
                    50u8
                } else {
                    25u8
                } as u64;
                recency
                    .checked_mul(individual_proof.weighted_score)
                    .and_then(|s| s.checked_div(100))
                    .ok_or(SolanIdError::Overflow)?
            } else {
                0
            };

        let is_new_user = user_proof.user == Pubkey::default();

        if is_new_user {
            user_proof.user = ctx.accounts.user.key();
            user_proof.last_submission = clock.unix_timestamp;
            user_proof.aggregated_score = 0;
            user_proof.active_source_count = 0;
            user_proof.valid_until = clock
                .unix_timestamp
                .checked_add(registry.proof_ttl_seconds)
                .ok_or(SolanIdError::Overflow)?;
            user_proof.bump = ctx.bumps.user_proof;
            registry.total_verified_users = registry
                .total_verified_users
                .checked_add(1)
                .ok_or(SolanIdError::Overflow)?;
        }

        let was_source_active =
            individual_proof.user != Pubkey::default() && !individual_proof.is_revoked;
        if !was_source_active {
            user_proof.active_source_count = user_proof
                .active_source_count
                .checked_add(1)
                .ok_or(SolanIdError::Overflow)?;
        }

        individual_proof.user = ctx.accounts.user.key();
        individual_proof.proof_hash = proof_hash;
        individual_proof.base_score = base_score;
        individual_proof.weighted_score = weighted_score;
        individual_proof.source = source;
        individual_proof.identity_nullifier = identity_nullifier;
        individual_proof.proof_data = proof_data;
        individual_proof.verified_at = timestamp;
        individual_proof.is_revoked = false;
        individual_proof.bump = ctx.bumps.individual_proof;

        attestation_nonce_registry.nonce = attestation_nonce;
        attestation_nonce_registry.is_used = true;
        attestation_nonce_registry.user = ctx.accounts.user.key();
        attestation_nonce_registry.used_at = clock.unix_timestamp;
        attestation_nonce_registry.bump = ctx.bumps.attestation_nonce_registry;

        let mut new_base_aggregated_score = old_base_aggregated_score
            .checked_sub(old_score)
            .unwrap_or(0);
        new_base_aggregated_score = new_base_aggregated_score
            .checked_add(recency_adjusted_score)
            .ok_or(SolanIdError::Overflow)?;

        user_proof.aggregated_score = apply_diversity_bonus(
            new_base_aggregated_score,
            user_proof.active_source_count,
            registry.diversity_bonus_percent,
        )?;

        user_proof.last_submission = clock.unix_timestamp;
        user_proof.valid_until = clock
            .unix_timestamp
            .checked_add(registry.proof_ttl_seconds)
            .ok_or(SolanIdError::Overflow)?;

        emit!(ProofSubmitted {
            user: ctx.accounts.user.key(),
            proof_hash,
            base_score,
            weighted_score,
            source,
            timestamp,
        });

        Ok(())
    }

    pub fn revoke_proof(ctx: Context<RevokeProof>, _source: ProofSource) -> Result<()> {
        let individual_proof = &mut ctx.accounts.individual_proof;
        let user_proof = &mut ctx.accounts.user_proof;
        let identity_nullifier_registry = &mut ctx.accounts.identity_nullifier_registry;
        let registry = &ctx.accounts.registry;
        let clock = Clock::get()?;

        require!(
            individual_proof.user == ctx.accounts.user.key(),
            SolanIdError::Unauthorized
        );

        require!(
            !individual_proof.is_revoked,
            SolanIdError::ProofAlreadyRevoked
        );

        require!(
            identity_nullifier_registry.nullifier == individual_proof.identity_nullifier,
            SolanIdError::InvalidIdentityNullifier
        );
        require!(
            identity_nullifier_registry.claimed_by == ctx.accounts.user.key(),
            SolanIdError::Unauthorized
        );

        let age_seconds = clock
            .unix_timestamp
            .checked_sub(individual_proof.verified_at)
            .unwrap_or(0);
        let recency_factor = if age_seconds < 2592000 {
            100u8
        } else if age_seconds < 7776000 {
            75u8
        } else if age_seconds < 15552000 {
            50u8
        } else {
            25u8
        };
        let recency_adjusted_score = individual_proof
            .weighted_score
            .checked_mul(recency_factor as u64)
            .and_then(|s| s.checked_div(100))
            .ok_or(SolanIdError::Overflow)?;

        let old_base_aggregated_score = strip_diversity_bonus(
            user_proof.aggregated_score,
            user_proof.active_source_count,
            registry.diversity_bonus_percent,
        )?;

        let new_base_aggregated_score = old_base_aggregated_score
            .checked_sub(recency_adjusted_score)
            .unwrap_or(0);

        user_proof.active_source_count = user_proof.active_source_count.checked_sub(1).unwrap_or(0);

        user_proof.aggregated_score = apply_diversity_bonus(
            new_base_aggregated_score,
            user_proof.active_source_count,
            registry.diversity_bonus_percent,
        )?;

        individual_proof.is_revoked = true;
        identity_nullifier_registry.is_burned = true;

        emit!(ProofRevoked {
            user: ctx.accounts.user.key(),
            proof_hash: individual_proof.proof_hash,
            source: individual_proof.source,
        });

        Ok(())
    }

    pub fn verify_proof(ctx: Context<VerifyProof>) -> Result<ProofStatus> {
        let user_proof = &ctx.accounts.user_proof;
        let registry = &ctx.accounts.registry;
        let clock = Clock::get()?;

        let is_unexpired = clock.unix_timestamp <= user_proof.valid_until;

        let is_valid = user_proof.user != Pubkey::default()
            && user_proof.aggregated_score >= registry.min_score
            && user_proof.aggregated_score > 0
            && is_unexpired;

        Ok(ProofStatus {
            is_verified: is_valid,
            aggregated_score: user_proof.aggregated_score,
            verified_at: user_proof.last_submission,
        })
    }

    pub fn update_min_score(ctx: Context<UpdateMinScore>, new_min_score: u64) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let old_score = registry.min_score;
        registry.min_score = new_min_score;
        emit!(MinScoreUpdated {
            old_score,
            new_score: new_min_score,
        });
        Ok(())
    }

    pub fn update_scoring_config(
        ctx: Context<UpdateScoringConfig>,
        source: ProofSource,
        weight: u64,
    ) -> Result<()> {
        let scoring_config = &mut ctx.accounts.scoring_config;
        scoring_config.weights[source as u8 as usize] = weight;
        emit!(ScoringConfigUpdated { source, weight });
        Ok(())
    }

    pub fn initialize_scoring_config(ctx: Context<InitializeScoringConfig>) -> Result<()> {
        let scoring_config = &mut ctx.accounts.scoring_config;
        scoring_config.authority = ctx.accounts.authority.key();
        scoring_config.weights = [100; 8];
        scoring_config.bump = ctx.bumps.scoring_config;
        Ok(())
    }

    pub fn update_registry_config(
        ctx: Context<UpdateRegistryConfig>,
        cooldown_period: i64,
        diversity_bonus_percent: u8,
        proof_ttl_seconds: i64,
    ) -> Result<()> {
        require!(cooldown_period >= 0, SolanIdError::InvalidConfig);
        require!(diversity_bonus_percent <= 100, SolanIdError::InvalidConfig);
        require!(proof_ttl_seconds > 0, SolanIdError::InvalidConfig);

        let registry = &mut ctx.accounts.registry;
        registry.cooldown_period = cooldown_period;
        registry.diversity_bonus_percent = diversity_bonus_percent;
        registry.proof_ttl_seconds = proof_ttl_seconds;
        Ok(())
    }

    pub fn initiate_verifier_rotation(
        ctx: Context<InitiateVerifierRotation>,
        new_verifier_authority: Pubkey,
        delay_seconds: i64,
    ) -> Result<()> {
        require!(
            new_verifier_authority != Pubkey::default(),
            SolanIdError::InvalidConfig
        );
        require!(delay_seconds >= 1, SolanIdError::InvalidConfig);

        let registry = &mut ctx.accounts.registry;
        let now = Clock::get()?.unix_timestamp;
        registry.pending_verifier_authority = new_verifier_authority;
        registry.verifier_rotation_available_at = now
            .checked_add(delay_seconds)
            .ok_or(SolanIdError::Overflow)?;

        emit!(VerifierRotationInitiated {
            current_verifier: registry.verifier_authority,
            pending_verifier: registry.pending_verifier_authority,
            activate_at: registry.verifier_rotation_available_at,
        });

        Ok(())
    }

    pub fn finalize_verifier_rotation(ctx: Context<FinalizeVerifierRotation>) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        require!(
            registry.pending_verifier_authority != Pubkey::default(),
            SolanIdError::NoVerifierRotationPending
        );

        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= registry.verifier_rotation_available_at,
            SolanIdError::VerifierRotationNotReady
        );

        let old_verifier = registry.verifier_authority;
        registry.verifier_authority = registry.pending_verifier_authority;
        registry.pending_verifier_authority = Pubkey::default();
        registry.verifier_rotation_available_at = 0;

        emit!(VerifierRotationFinalized {
            old_verifier,
            new_verifier: registry.verifier_authority,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Registry::INIT_SPACE,
        seeds = [b"registry"],
        bump
    )]
    pub registry: Account<'info, Registry>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    proof_hash: [u8; 32],
    source: ProofSource,
    identity_nullifier: [u8; 32],
    attestation_nonce: u64
)]
pub struct SubmitProof<'info> {
    #[account(mut)]
    pub registry: Account<'info, Registry>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserProof::INIT_SPACE,
        seeds = [b"user_proof", user.key().as_ref()],
        bump
    )]
    pub user_proof: Account<'info, UserProof>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + IndividualProof::INIT_SPACE,
        seeds = [b"individual_proof", user.key().as_ref(), &[source as u8]],
        bump
    )]
    pub individual_proof: Account<'info, IndividualProof>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + IdentityNullifierRegistry::INIT_SPACE,
        seeds = [b"identity_nullifier", identity_nullifier.as_ref()],
        bump
    )]
    pub identity_nullifier_registry: Account<'info, IdentityNullifierRegistry>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + AttestationNonceRegistry::INIT_SPACE,
        seeds = [
            b"attestation_nonce",
            registry.key().as_ref(),
            &attestation_nonce.to_le_bytes(),
        ],
        bump
    )]
    pub attestation_nonce_registry: Account<'info, AttestationNonceRegistry>,
    pub scoring_config: Account<'info, ScoringConfig>,
    /// CHECK: Verified via sysvar instructions address constraint.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(source: ProofSource)]
pub struct RevokeProof<'info> {
    #[account(mut)]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        seeds = [b"user_proof", user.key().as_ref()],
        bump = user_proof.bump
    )]
    pub user_proof: Account<'info, UserProof>,
    #[account(
        mut,
        seeds = [b"individual_proof", user.key().as_ref(), &[source as u8]],
        bump = individual_proof.bump
    )]
    pub individual_proof: Account<'info, IndividualProof>,
    #[account(mut)]
    pub identity_nullifier_registry: Account<'info, IdentityNullifierRegistry>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct VerifyProof<'info> {
    #[account(
        seeds = [b"user_proof", user.key().as_ref()],
        bump = user_proof.bump
    )]
    pub user_proof: Account<'info, UserProof>,
    pub registry: Account<'info, Registry>,
    /// CHECK: User account is only used to derive the PDA for user_proof. The user_proof account validation ensures correctness.
    pub user: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateMinScore<'info> {
    #[account(
        mut,
        seeds = [b"registry"],
        bump = registry.bump,
        has_one = authority @ SolanIdError::Unauthorized
    )]
    pub registry: Account<'info, Registry>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeScoringConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ScoringConfig::INIT_SPACE,
        seeds = [b"scoring_config"],
        bump
    )]
    pub scoring_config: Account<'info, ScoringConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateScoringConfig<'info> {
    #[account(
        mut,
        seeds = [b"scoring_config"],
        bump = scoring_config.bump,
        has_one = authority @ SolanIdError::Unauthorized
    )]
    pub scoring_config: Account<'info, ScoringConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateRegistryConfig<'info> {
    #[account(
        mut,
        seeds = [b"registry"],
        bump = registry.bump,
        has_one = authority @ SolanIdError::Unauthorized
    )]
    pub registry: Account<'info, Registry>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitiateVerifierRotation<'info> {
    #[account(
        mut,
        seeds = [b"registry"],
        bump = registry.bump,
        has_one = authority @ SolanIdError::Unauthorized
    )]
    pub registry: Account<'info, Registry>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeVerifierRotation<'info> {
    #[account(
        mut,
        seeds = [b"registry"],
        bump = registry.bump,
        has_one = authority @ SolanIdError::Unauthorized
    )]
    pub registry: Account<'info, Registry>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub authority: Pubkey,
    pub verifier_authority: Pubkey,
    pub pending_verifier_authority: Pubkey,
    pub verifier_rotation_available_at: i64,
    pub total_verified_users: u64,
    pub min_score: u64,
    pub cooldown_period: i64,
    pub diversity_bonus_percent: u8,
    pub proof_ttl_seconds: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserProof {
    pub user: Pubkey,
    pub aggregated_score: u64,
    pub last_submission: i64,
    pub valid_until: i64,
    pub active_source_count: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct IndividualProof {
    pub user: Pubkey,
    pub proof_hash: [u8; 32],
    pub base_score: u64,
    pub weighted_score: u64,
    pub source: ProofSource,
    pub identity_nullifier: [u8; 32],
    pub proof_data: SourceProofData,
    pub verified_at: i64,
    pub is_revoked: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ProofHashRegistry {
    pub is_used: bool,
    pub user: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ScoringConfig {
    pub authority: Pubkey,
    pub weights: [u64; 8],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct IdentityNullifierRegistry {
    pub nullifier: [u8; 32],
    pub source: ProofSource,
    pub claimed_by: Pubkey,
    pub is_burned: bool,
    pub claimed_at: i64,
    pub last_proof_hash: [u8; 32],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AttestationNonceRegistry {
    pub nonce: u64,
    pub is_used: bool,
    pub user: Pubkey,
    pub used_at: i64,
    pub bump: u8,
}

fn apply_diversity_bonus(
    base_score: u64,
    active_source_count: u8,
    diversity_bonus_percent: u8,
) -> Result<u64> {
    if active_source_count <= 1 || diversity_bonus_percent == 0 {
        return Ok(base_score);
    }

    let diversity_bonus = base_score
        .checked_mul(diversity_bonus_percent as u64)
        .and_then(|s| s.checked_div(100))
        .ok_or(SolanIdError::Overflow)?;

    base_score
        .checked_add(diversity_bonus)
        .ok_or(SolanIdError::Overflow.into())
}

fn strip_diversity_bonus(
    total_score: u64,
    active_source_count: u8,
    diversity_bonus_percent: u8,
) -> Result<u64> {
    if active_source_count <= 1 || diversity_bonus_percent == 0 {
        return Ok(total_score);
    }

    total_score
        .checked_mul(100)
        .and_then(|s| s.checked_div(100 + diversity_bonus_percent as u64))
        .ok_or(SolanIdError::Overflow.into())
}

fn read_u16_le(data: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .ok_or(SolanIdError::InvalidAttestationInstruction)?;
    let bytes = data
        .get(offset..end)
        .ok_or(SolanIdError::InvalidAttestationInstruction)?;

    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn build_attestation_message(
    program_id: &Pubkey,
    registry: &Pubkey,
    user: &Pubkey,
    proof_hash: &[u8; 32],
    source: ProofSource,
    identity_nullifier: &[u8; 32],
    attestation_nonce: u64,
    base_score: u64,
    timestamp: i64,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(190);
    message.extend_from_slice(b"sid1");
    message.extend_from_slice(program_id.as_ref());
    message.extend_from_slice(registry.as_ref());
    message.extend_from_slice(user.as_ref());
    message.push(source as u8);
    message.extend_from_slice(identity_nullifier);
    message.extend_from_slice(&attestation_nonce.to_le_bytes());
    message.extend_from_slice(&base_score.to_le_bytes());
    message.extend_from_slice(&timestamp.to_le_bytes());
    message.extend_from_slice(proof_hash);
    message
}

fn verify_verifier_attestation(
    instruction_sysvar: &AccountInfo,
    program_id: &Pubkey,
    registry: Pubkey,
    user: Pubkey,
    proof_hash: [u8; 32],
    source: ProofSource,
    identity_nullifier: [u8; 32],
    attestation_nonce: u64,
    base_score: u64,
    timestamp: i64,
    verifier_authority: Pubkey,
) -> Result<()> {
    let current_index = load_current_index_checked(instruction_sysvar)
        .map_err(|_| error!(SolanIdError::InvalidAttestationInstruction))?
        as usize;

    require!(
        current_index > 0,
        SolanIdError::InvalidAttestationInstruction
    );

    let prior_ix = load_instruction_at_checked(current_index - 1, instruction_sysvar)
        .map_err(|_| error!(SolanIdError::InvalidAttestationInstruction))?;

    validate_ed25519_instruction(
        &prior_ix,
        &build_attestation_message(
            program_id,
            &registry,
            &user,
            &proof_hash,
            source,
            &identity_nullifier,
            attestation_nonce,
            base_score,
            timestamp,
        ),
        &verifier_authority,
    )
}

fn validate_ed25519_instruction(
    instruction: &Instruction,
    expected_message: &[u8],
    expected_signer: &Pubkey,
) -> Result<()> {
    let ed25519_program_id = Pubkey::from_str("Ed25519SigVerify111111111111111111111111111")
        .map_err(|_| error!(SolanIdError::InvalidAttestationInstruction))?;

    require!(
        instruction.program_id == ed25519_program_id,
        SolanIdError::InvalidAttestationInstruction
    );

    let data = &instruction.data;
    require!(
        data.len() >= 16,
        SolanIdError::InvalidAttestationInstruction
    );
    require!(data[0] == 1, SolanIdError::InvalidAttestationInstruction);

    let signature_offset = read_u16_le(data, 2)? as usize;
    let signature_instruction_index = read_u16_le(data, 4)?;
    let public_key_offset = read_u16_le(data, 6)? as usize;
    let public_key_instruction_index = read_u16_le(data, 8)?;
    let message_data_offset = read_u16_le(data, 10)? as usize;
    let message_data_size = read_u16_le(data, 12)? as usize;
    let message_instruction_index = read_u16_le(data, 14)?;

    require!(
        signature_instruction_index == u16::MAX
            && public_key_instruction_index == u16::MAX
            && message_instruction_index == u16::MAX,
        SolanIdError::InvalidAttestationInstruction
    );

    let signature_end = signature_offset
        .checked_add(64)
        .ok_or(SolanIdError::InvalidAttestationInstruction)?;
    let public_key_end = public_key_offset
        .checked_add(32)
        .ok_or(SolanIdError::InvalidAttestationInstruction)?;
    let message_end = message_data_offset
        .checked_add(message_data_size)
        .ok_or(SolanIdError::InvalidAttestationInstruction)?;

    let _signature = data
        .get(signature_offset..signature_end)
        .ok_or(SolanIdError::InvalidAttestationInstruction)?;
    let public_key = data
        .get(public_key_offset..public_key_end)
        .ok_or(SolanIdError::InvalidAttestationInstruction)?;
    let message = data
        .get(message_data_offset..message_end)
        .ok_or(SolanIdError::InvalidAttestationInstruction)?;

    require!(
        public_key == expected_signer.as_ref(),
        SolanIdError::InvalidAttestationMessage
    );
    require!(
        message == expected_message,
        SolanIdError::InvalidAttestationMessage
    );

    Ok(())
}

fn is_non_zero_hash(hash: &[u8; 32]) -> bool {
    hash.iter().any(|b| *b != 0)
}

fn extract_identity_nullifier(
    source: ProofSource,
    proof_data: &SourceProofData,
) -> Result<[u8; 32]> {
    match (source, proof_data) {
        (ProofSource::Reclaim, SourceProofData::Reclaim { identity_hash, .. }) => {
            Ok(*identity_hash)
        }
        (ProofSource::GitcoinPassport, SourceProofData::GitcoinPassport { did_hash, .. }) => {
            Ok(*did_hash)
        }
        (ProofSource::WorldId, SourceProofData::WorldId { nullifier_hash, .. }) => {
            Ok(*nullifier_hash)
        }
        _ => err!(SolanIdError::SourcePayloadMismatch),
    }
}

fn validate_source_proof_data(
    source: ProofSource,
    proof_data: &SourceProofData,
    base_score: u64,
    now: i64,
) -> Result<()> {
    match (source, proof_data) {
        (
            ProofSource::Reclaim,
            SourceProofData::Reclaim {
                identity_hash,
                provider_hash,
                response_hash,
                issued_at,
            },
        ) => {
            require!(
                is_non_zero_hash(identity_hash),
                SolanIdError::InvalidSourceProofData
            );
            require!(
                is_non_zero_hash(provider_hash),
                SolanIdError::InvalidSourceProofData
            );
            require!(
                is_non_zero_hash(response_hash),
                SolanIdError::InvalidSourceProofData
            );
            require!(
                *issued_at <= now + 300,
                SolanIdError::InvalidSourceProofData
            );
            require!(
                *issued_at >= now - 86_400,
                SolanIdError::InvalidSourceProofData
            );
        }
        (
            ProofSource::GitcoinPassport,
            SourceProofData::GitcoinPassport {
                did_hash,
                stamp_count,
                passport_score,
                model_version,
            },
        ) => {
            require!(
                is_non_zero_hash(did_hash),
                SolanIdError::InvalidSourceProofData
            );
            require!(*stamp_count > 0, SolanIdError::InvalidSourceProofData);
            require!(*passport_score > 0, SolanIdError::InvalidSourceProofData);
            require!(*model_version > 0, SolanIdError::InvalidSourceProofData);
            require!(
                base_score <= *passport_score as u64,
                SolanIdError::InvalidSourceProofData
            );
        }
        (
            ProofSource::WorldId,
            SourceProofData::WorldId {
                nullifier_hash,
                merkle_root,
                verification_level,
            },
        ) => {
            require!(
                is_non_zero_hash(nullifier_hash),
                SolanIdError::InvalidSourceProofData
            );
            require!(
                is_non_zero_hash(merkle_root),
                SolanIdError::InvalidSourceProofData
            );
            require!(
                (1..=2).contains(verification_level),
                SolanIdError::InvalidSourceProofData
            );
        }
        (
            ProofSource::BrightId,
            SourceProofData::BrightId {
                context_hash,
                group_hash,
            },
        ) => {
            require!(
                is_non_zero_hash(context_hash),
                SolanIdError::InvalidSourceProofData
            );
            require!(
                is_non_zero_hash(group_hash),
                SolanIdError::InvalidSourceProofData
            );
        }
        (
            ProofSource::Lens,
            SourceProofData::Lens {
                profile_id,
                handle_hash,
            },
        ) => {
            require!(*profile_id > 0, SolanIdError::InvalidSourceProofData);
            require!(
                is_non_zero_hash(handle_hash),
                SolanIdError::InvalidSourceProofData
            );
        }
        (
            ProofSource::Twitter,
            SourceProofData::Twitter {
                handle_hash,
                tweet_id,
            },
        ) => {
            require!(*tweet_id > 0, SolanIdError::InvalidSourceProofData);
            require!(
                is_non_zero_hash(handle_hash),
                SolanIdError::InvalidSourceProofData
            );
        }
        (
            ProofSource::Google,
            SourceProofData::Google {
                account_hash,
                domain_hash,
            },
        ) => {
            require!(
                is_non_zero_hash(account_hash),
                SolanIdError::InvalidSourceProofData
            );
            require!(
                is_non_zero_hash(domain_hash),
                SolanIdError::InvalidSourceProofData
            );
        }
        (
            ProofSource::Discord,
            SourceProofData::Discord {
                user_id_hash,
                guild_id_hash,
            },
        ) => {
            require!(
                is_non_zero_hash(user_id_hash),
                SolanIdError::InvalidSourceProofData
            );
            require!(
                is_non_zero_hash(guild_id_hash),
                SolanIdError::InvalidSourceProofData
            );
        }
        _ => return err!(SolanIdError::SourcePayloadMismatch),
    }

    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ProofSource {
    Reclaim = 0,
    GitcoinPassport = 1,
    WorldId = 2,
    BrightId = 3,
    Lens = 4,
    Twitter = 5,
    Google = 6,
    Discord = 7,
}

impl anchor_lang::Space for ProofSource {
    const INIT_SPACE: usize = 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, PartialEq, Eq)]
pub enum SourceProofData {
    Reclaim {
        identity_hash: [u8; 32],
        provider_hash: [u8; 32],
        response_hash: [u8; 32],
        issued_at: i64,
    },
    GitcoinPassport {
        did_hash: [u8; 32],
        stamp_count: u16,
        passport_score: u16,
        model_version: u8,
    },
    WorldId {
        nullifier_hash: [u8; 32],
        merkle_root: [u8; 32],
        verification_level: u8,
    },
    BrightId {
        context_hash: [u8; 32],
        group_hash: [u8; 32],
    },
    Lens {
        profile_id: u64,
        handle_hash: [u8; 32],
    },
    Twitter {
        handle_hash: [u8; 32],
        tweet_id: u64,
    },
    Google {
        account_hash: [u8; 32],
        domain_hash: [u8; 32],
    },
    Discord {
        user_id_hash: [u8; 32],
        guild_id_hash: [u8; 32],
    },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofStatus {
    pub is_verified: bool,
    pub aggregated_score: u64,
    pub verified_at: i64,
}

#[event]
pub struct ProofSubmitted {
    pub user: Pubkey,
    pub proof_hash: [u8; 32],
    pub base_score: u64,
    pub weighted_score: u64,
    pub source: ProofSource,
    pub timestamp: i64,
}

#[event]
pub struct ProofRevoked {
    pub user: Pubkey,
    pub proof_hash: [u8; 32],
    pub source: ProofSource,
}

#[event]
pub struct MinScoreUpdated {
    pub old_score: u64,
    pub new_score: u64,
}

#[event]
pub struct ScoringConfigUpdated {
    pub source: ProofSource,
    pub weight: u64,
}

#[event]
pub struct VerifierRotationInitiated {
    pub current_verifier: Pubkey,
    pub pending_verifier: Pubkey,
    pub activate_at: i64,
}

#[event]
pub struct VerifierRotationFinalized {
    pub old_verifier: Pubkey,
    pub new_verifier: Pubkey,
}

#[error_code]
pub enum SolanIdError {
    #[msg("Score is below the minimum threshold")]
    ScoreBelowThreshold,
    #[msg("Invalid timestamp")]
    InvalidTimestamp,
    #[msg("Proof has expired")]
    ProofExpired,
    #[msg("Unauthorized action")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Proof hash has already been used")]
    ProofHashAlreadyUsed,
    #[msg("Proof is already revoked")]
    ProofAlreadyRevoked,
    #[msg("Cooldown period is still active")]
    CooldownPeriodActive,
    #[msg("Invalid registry configuration")]
    InvalidConfig,
    #[msg("Proof source payload does not match source type")]
    SourcePayloadMismatch,
    #[msg("Invalid proof payload for selected source")]
    InvalidSourceProofData,
    #[msg("Invalid verifier attestation instruction")]
    InvalidAttestationInstruction,
    #[msg("Invalid verifier attestation message")]
    InvalidAttestationMessage,
    #[msg("Identity nullifier is invalid for source payload")]
    InvalidIdentityNullifier,
    #[msg("Identity has already been claimed by another wallet")]
    DuplicateIdentityClaim,
    #[msg("Identity has been revoked permanently")]
    IdentityRevokedPermanent,
    #[msg("Attestation nonce was already used")]
    AttestationNonceAlreadyUsed,
    #[msg("No verifier rotation is pending")]
    NoVerifierRotationPending,
    #[msg("Verifier rotation delay has not elapsed")]
    VerifierRotationNotReady,
}
