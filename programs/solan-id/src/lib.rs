use anchor_lang::prelude::*;

declare_id!("FGoa1MtyJRXew4FKdCSAMFfLEK7Y2GMfSjc2NsPrmX9p");

#[program]
pub mod solan_id {
    use super::*;

    pub fn initialize_registry(ctx: Context<InitializeRegistry>, min_score: u64) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.total_verified_users = 0;
        registry.min_score = min_score;
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    pub fn submit_proof(
        ctx: Context<SubmitProof>,
        proof_hash: [u8; 32],
        score: u64,
        source: ProofSource,
        timestamp: i64,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let user_proof = &mut ctx.accounts.user_proof;
        let clock = Clock::get()?;

        require!(
            score >= registry.min_score,
            SolanIdError::ScoreBelowThreshold
        );

        require!(
            timestamp <= clock.unix_timestamp + 300,
            SolanIdError::InvalidTimestamp
        );

        require!(
            timestamp >= clock.unix_timestamp - 3600,
            SolanIdError::ProofExpired
        );

        let is_new_user = user_proof.user == Pubkey::default();

        user_proof.user = ctx.accounts.user.key();
        user_proof.proof_hash = proof_hash;
        user_proof.score = score;
        user_proof.source = source;
        user_proof.verified_at = timestamp;
        user_proof.bump = ctx.bumps.user_proof;

        if is_new_user {
            registry.total_verified_users = registry.total_verified_users
                .checked_add(1)
                .ok_or(SolanIdError::Overflow)?;
        }

        emit!(ProofSubmitted {
            user: ctx.accounts.user.key(),
            proof_hash,
            score,
            source,
            timestamp,
        });

        Ok(())
    }

    pub fn update_proof(
        ctx: Context<UpdateProof>,
        proof_hash: [u8; 32],
        score: u64,
        source: ProofSource,
        timestamp: i64,
    ) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let user_proof = &mut ctx.accounts.user_proof;
        let clock = Clock::get()?;

        require!(
            user_proof.user == ctx.accounts.user.key(),
            SolanIdError::Unauthorized
        );

        require!(
            score >= registry.min_score,
            SolanIdError::ScoreBelowThreshold
        );

        require!(
            timestamp <= clock.unix_timestamp + 300,
            SolanIdError::InvalidTimestamp
        );

        require!(
            timestamp >= clock.unix_timestamp - 3600,
            SolanIdError::ProofExpired
        );

        user_proof.proof_hash = proof_hash;
        user_proof.score = score;
        user_proof.source = source;
        user_proof.verified_at = timestamp;

        emit!(ProofUpdated {
            user: ctx.accounts.user.key(),
            proof_hash,
            score,
            source,
            timestamp,
        });

        Ok(())
    }

    pub fn verify_proof(ctx: Context<VerifyProof>) -> Result<ProofStatus> {
        let user_proof = &ctx.accounts.user_proof;
        let clock = Clock::get()?;

        let is_valid = user_proof.user != Pubkey::default()
            && user_proof.verified_at > 0
            && (clock.unix_timestamp - user_proof.verified_at) < 31536000;

        Ok(ProofStatus {
            is_verified: is_valid,
            score: user_proof.score,
            source: user_proof.source,
            verified_at: user_proof.verified_at,
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
        scoring_config.weights[source as usize] = weight;
        emit!(ScoringConfigUpdated {
            source,
            weight,
        });
        Ok(())
    }

    pub fn initialize_scoring_config(ctx: Context<InitializeScoringConfig>) -> Result<()> {
        let scoring_config = &mut ctx.accounts.scoring_config;
        scoring_config.authority = ctx.accounts.authority.key();
        scoring_config.weights = [100; 8];
        scoring_config.bump = ctx.bumps.scoring_config;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Registry::LEN,
        seeds = [b"registry"],
        bump
    )]
    pub registry: Account<'info, Registry>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitProof<'info> {
    #[account(mut)]
    pub registry: Account<'info, Registry>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserProof::LEN,
        seeds = [b"user_proof", user.key().as_ref()],
        bump
    )]
    pub user_proof: Account<'info, UserProof>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProof<'info> {
    #[account(mut)]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        seeds = [b"user_proof", user.key().as_ref()],
        bump = user_proof.bump
    )]
    pub user_proof: Account<'info, UserProof>,
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
        space = 8 + ScoringConfig::LEN,
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

#[account]
pub struct Registry {
    pub authority: Pubkey,
    pub total_verified_users: u64,
    pub min_score: u64,
    pub bump: u8,
}

impl Registry {
    pub const LEN: usize = 32 + 8 + 8 + 1;
}

#[account]
pub struct UserProof {
    pub user: Pubkey,
    pub proof_hash: [u8; 32],
    pub score: u64,
    pub source: ProofSource,
    pub verified_at: i64,
    pub bump: u8,
}

impl UserProof {
    pub const LEN: usize = 32 + 32 + 8 + 1 + 8 + 1;
}

#[account]
pub struct ScoringConfig {
    pub authority: Pubkey,
    pub weights: [u64; 8],
    pub bump: u8,
}

impl ScoringConfig {
    pub const LEN: usize = 32 + (8 * 8) + 1;
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofStatus {
    pub is_verified: bool,
    pub score: u64,
    pub source: ProofSource,
    pub verified_at: i64,
}

#[event]
pub struct ProofSubmitted {
    pub user: Pubkey,
    pub proof_hash: [u8; 32],
    pub score: u64,
    pub source: ProofSource,
    pub timestamp: i64,
}

#[event]
pub struct ProofUpdated {
    pub user: Pubkey,
    pub proof_hash: [u8; 32],
    pub score: u64,
    pub source: ProofSource,
    pub timestamp: i64,
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
}

