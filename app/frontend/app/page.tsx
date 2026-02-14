"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAnchorWallet,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  finalizeRotation,
  getProgram,
  initiateRotation,
  revokeProof,
  submitProof,
  updateRegistryConfig,
  verifyProof,
} from "../lib/protocol";

const unixNow = () => Math.floor(Date.now() / 1000);

export default function Page() {
  const { connected, publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();

  const wallet = publicKey?.toBase58() ?? "";
  const isConnected = useMemo(
    () => connected && Boolean(publicKey),
    [connected, publicKey]
  );
  const program = useMemo(
    () => (anchorWallet ? getProgram(connection, anchorWallet) : null),
    [connection, anchorWallet]
  );

  const [logs, setLogs] = useState<string[]>([]);
  const [verifyOutput, setVerifyOutput] = useState(
    "No verification result yet."
  );

  const [submitForm, setSubmitForm] = useState({
    source: "reclaim",
    score: "150",
    timestamp: "",
    nonce: "1",
    proofHash: "",
    identityNullifier: "",
    payload:
      '{"reclaim":{"identityHash":[11],"providerHash":[12],"responseHash":[13],"issuedAt":0}}',
  });
  const [verifyAddress, setVerifyAddress] = useState("");
  const [revokeForm, setRevokeForm] = useState({
    source: "reclaim",
    nullifier: "",
  });
  const [configForm, setConfigForm] = useState({
    cooldown: "0",
    bonus: "20",
    ttl: "3600",
  });
  const [rotationForm, setRotationForm] = useState({
    verifier: "",
    delay: "60",
  });
  const [pending, setPending] = useState({
    submit: false,
    verify: false,
    revoke: false,
    config: false,
    rotateInit: false,
    rotateFinalize: false,
  });
  const [notice, setNotice] = useState<{
    type: "ok" | "error";
    text: string;
  } | null>(null);

  const addLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 120));
  };

  const explorerTxUrl = (sig: string) => {
    const cluster = process.env.NEXT_PUBLIC_EXPLORER_CLUSTER || "devnet";
    return `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
  };

  const runAction = async (
    key: keyof typeof pending,
    action: () => Promise<void>
  ) => {
    setNotice(null);
    setPending((prev) => ({ ...prev, [key]: true }));
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setNotice({ type: "error", text: message });
      addLog(`Error: ${message}`);
    } finally {
      setPending((prev) => ({ ...prev, [key]: false }));
    }
  };

  useEffect(() => {
    setSubmitForm((prev) => ({ ...prev, timestamp: String(unixNow()) }));
    setLogs([`[${new Date().toLocaleTimeString()}] Ready.`]);
  }, []);

  useEffect(() => {
    if (wallet) {
      setVerifyAddress((prev) => prev || wallet);
      addLog("Wallet connected.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  return (
    <div className="page">
      <header className="top">
        <div>
          <p className="eyebrow">SolanID</p>
          <h1>Protocol Console</h1>
          <p className="muted">
            Wallet adapter connected. Actions now call on-chain methods.
          </p>
        </div>
        <div className="topActions">
          <span className={`pill ${isConnected ? "ok" : "off"}`}>
            {isConnected ? "Connected" : "Disconnected"}
          </span>
          <WalletMultiButton className="walletBtn" />
        </div>
      </header>

      <section className="meta card">
        <div>
          <p className="label">Wallet</p>
          <p className="mono break">{wallet || "No wallet connected"}</p>
        </div>
        <div>
          <p className="label">Cluster</p>
          <p>{process.env.NEXT_PUBLIC_RPC_URL || "devnet"}</p>
        </div>
      </section>

      {notice && (
        <section className={`card block notice ${notice.type}`}>
          {notice.text}
        </section>
      )}

      <main className="grid two">
        <section className="card block">
          <h2>Submit Proof</h2>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              await runAction("submit", async () => {
                if (!program || !publicKey)
                  throw new Error("Connect wallet first");

                const sig = await submitProof({
                  program,
                  user: publicKey,
                  source: submitForm.source,
                  score: submitForm.score,
                  timestamp: submitForm.timestamp,
                  nonce: submitForm.nonce,
                  proofHashHex: submitForm.proofHash,
                  identityNullifierHex: submitForm.identityNullifier,
                  payloadJson: submitForm.payload,
                });

                setNotice({
                  type: "ok",
                  text: "Proof submitted successfully.",
                });
                addLog(`Submit success: ${sig}`);
                addLog(`Explorer: ${explorerTxUrl(sig)}`);
              });
            }}
          >
            <label>
              Source
              <select
                value={submitForm.source}
                onChange={(e) =>
                  setSubmitForm((s) => ({ ...s, source: e.target.value }))
                }
              >
                <option value="reclaim">Reclaim</option>
                <option value="gitcoinPassport">Gitcoin Passport</option>
                <option value="worldId">World ID</option>
              </select>
            </label>
            <label>
              Base Score
              <input
                value={submitForm.score}
                onChange={(e) =>
                  setSubmitForm((s) => ({ ...s, score: e.target.value }))
                }
              />
            </label>
            <label>
              Timestamp
              <input
                value={submitForm.timestamp}
                onChange={(e) =>
                  setSubmitForm((s) => ({ ...s, timestamp: e.target.value }))
                }
              />
            </label>
            <label>
              Attestation Nonce
              <input
                value={submitForm.nonce}
                onChange={(e) =>
                  setSubmitForm((s) => ({ ...s, nonce: e.target.value }))
                }
              />
            </label>
            <label className="full">
              Proof Hash (hex)
              <input
                value={submitForm.proofHash}
                onChange={(e) =>
                  setSubmitForm((s) => ({ ...s, proofHash: e.target.value }))
                }
              />
            </label>
            <label className="full">
              Identity Nullifier (hex)
              <input
                value={submitForm.identityNullifier}
                onChange={(e) =>
                  setSubmitForm((s) => ({
                    ...s,
                    identityNullifier: e.target.value,
                  }))
                }
              />
            </label>
            <label className="full">
              Source Payload (JSON)
              <textarea
                rows={5}
                value={submitForm.payload}
                onChange={(e) =>
                  setSubmitForm((s) => ({ ...s, payload: e.target.value }))
                }
              />
            </label>
            <button
              className="btn primary"
              disabled={pending.submit || !isConnected}
            >
              {pending.submit ? "Submitting..." : "Submit Proof"}
            </button>
          </form>
        </section>

        <section className="stack">
          <section className="card block">
            <h2>Verify Status</h2>
            <form
              className="form single"
              onSubmit={async (e) => {
                e.preventDefault();
                await runAction("verify", async () => {
                  if (!program) throw new Error("Connect wallet first");
                  const result = await verifyProof({
                    program,
                    user: verifyAddress,
                  });
                  setVerifyOutput(JSON.stringify(result, null, 2));
                  setNotice({ type: "ok", text: "Verification fetched." });
                  addLog(`Verify success for ${verifyAddress}`);
                });
              }}
            >
              <label>
                User Address
                <input
                  value={verifyAddress}
                  onChange={(e) => setVerifyAddress(e.target.value)}
                />
              </label>
              <button className="btn" disabled={pending.verify || !isConnected}>
                {pending.verify ? "Checking..." : "Check"}
              </button>
            </form>
            <pre className="result mono">{verifyOutput}</pre>
          </section>

          <section className="card block">
            <h2>Revoke Proof</h2>
            <form
              className="form single"
              onSubmit={async (e) => {
                e.preventDefault();
                await runAction("revoke", async () => {
                  if (!program || !publicKey)
                    throw new Error("Connect wallet first");
                  const sig = await revokeProof({
                    program,
                    user: publicKey,
                    source: revokeForm.source,
                    identityNullifierHex: revokeForm.nullifier,
                  });
                  setNotice({ type: "ok", text: "Proof revoked." });
                  addLog(`Revoke success: ${sig}`);
                  addLog(`Explorer: ${explorerTxUrl(sig)}`);
                });
              }}
            >
              <label>
                Source
                <select
                  value={revokeForm.source}
                  onChange={(e) =>
                    setRevokeForm((s) => ({ ...s, source: e.target.value }))
                  }
                >
                  <option value="reclaim">Reclaim</option>
                  <option value="gitcoinPassport">Gitcoin Passport</option>
                  <option value="worldId">World ID</option>
                </select>
              </label>
              <label>
                Identity Nullifier
                <input
                  value={revokeForm.nullifier}
                  onChange={(e) =>
                    setRevokeForm((s) => ({ ...s, nullifier: e.target.value }))
                  }
                />
              </label>
              <button
                className="btn danger"
                disabled={pending.revoke || !isConnected}
              >
                {pending.revoke ? "Revoking..." : "Revoke"}
              </button>
            </form>
          </section>
        </section>
      </main>

      <section className="grid two">
        <section className="card block">
          <h2>Registry Config</h2>
          <form
            className="form single"
            onSubmit={async (e) => {
              e.preventDefault();
              await runAction("config", async () => {
                if (!program || !publicKey)
                  throw new Error("Connect wallet first");
                const sig = await updateRegistryConfig({
                  program,
                  authority: publicKey,
                  cooldown: configForm.cooldown,
                  bonus: configForm.bonus,
                  ttl: configForm.ttl,
                });
                setNotice({ type: "ok", text: "Registry config updated." });
                addLog(`Config update success: ${sig}`);
                addLog(`Explorer: ${explorerTxUrl(sig)}`);
              });
            }}
          >
            <label>
              Cooldown Seconds
              <input
                value={configForm.cooldown}
                onChange={(e) =>
                  setConfigForm((s) => ({ ...s, cooldown: e.target.value }))
                }
              />
            </label>
            <label>
              Diversity Bonus %
              <input
                value={configForm.bonus}
                onChange={(e) =>
                  setConfigForm((s) => ({ ...s, bonus: e.target.value }))
                }
              />
            </label>
            <label>
              Proof TTL Seconds
              <input
                value={configForm.ttl}
                onChange={(e) =>
                  setConfigForm((s) => ({ ...s, ttl: e.target.value }))
                }
              />
            </label>
            <button className="btn" disabled={pending.config || !isConnected}>
              {pending.config ? "Updating..." : "Update Config"}
            </button>
          </form>
        </section>

        <section className="card block">
          <h2>Verifier Rotation</h2>
          <form
            className="form single"
            onSubmit={async (e) => {
              e.preventDefault();
              await runAction("rotateInit", async () => {
                if (!program || !publicKey)
                  throw new Error("Connect wallet first");
                const sig = await initiateRotation({
                  program,
                  authority: publicKey,
                  verifier: rotationForm.verifier,
                  delay: rotationForm.delay,
                });
                setNotice({ type: "ok", text: "Verifier rotation initiated." });
                addLog(`Rotation initiate success: ${sig}`);
                addLog(`Explorer: ${explorerTxUrl(sig)}`);
              });
            }}
          >
            <label>
              New Verifier Pubkey
              <input
                value={rotationForm.verifier}
                onChange={(e) =>
                  setRotationForm((s) => ({ ...s, verifier: e.target.value }))
                }
              />
            </label>
            <label>
              Delay Seconds
              <input
                value={rotationForm.delay}
                onChange={(e) =>
                  setRotationForm((s) => ({ ...s, delay: e.target.value }))
                }
              />
            </label>
            <div className="row">
              <button
                className="btn"
                disabled={pending.rotateInit || !isConnected}
              >
                {pending.rotateInit ? "Initiating..." : "Initiate"}
              </button>
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  await runAction("rotateFinalize", async () => {
                    if (!program || !publicKey)
                      throw new Error("Connect wallet first");
                    const sig = await finalizeRotation({
                      program,
                      authority: publicKey,
                    });
                    setNotice({
                      type: "ok",
                      text: "Verifier rotation finalized.",
                    });
                    addLog(`Rotation finalize success: ${sig}`);
                    addLog(`Explorer: ${explorerTxUrl(sig)}`);
                  });
                }}
                disabled={pending.rotateFinalize || !isConnected}
              >
                {pending.rotateFinalize ? "Finalizing..." : "Finalize"}
              </button>
            </div>
          </form>
        </section>
      </section>

      <section className="card block">
        <div className="row between">
          <h2>Activity</h2>
          <button className="btn ghost" onClick={() => setLogs([])}>
            Clear
          </button>
        </div>
        <div className="log mono">
          {logs.length === 0
            ? "No logs."
            : logs.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      </section>
    </div>
  );
}
