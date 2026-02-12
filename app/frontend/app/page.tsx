"use client";

import { useEffect, useMemo, useState } from "react";

const nowUnix = () => Math.floor(Date.now() / 1000);

declare global {
  interface Window {
    solana?: {
      connect: () => Promise<{ publicKey: { toString: () => string } }>;
    };
  }
}

export default function Page() {
  const [wallet, setWallet] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [verifyResult, setVerifyResult] = useState(
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
    identityNullifier: "",
  });

  const [registryForm, setRegistryForm] = useState({
    cooldown: "0",
    diversityBonus: "20",
    ttl: "3600",
  });

  const [rotationForm, setRotationForm] = useState({
    verifier: "",
    delay: "60",
  });

  const connected = useMemo(() => wallet.length > 0, [wallet]);

  useEffect(() => {
    setSubmitForm((s) => ({ ...s, timestamp: String(nowUnix()) }));
    setLogs([`[${new Date().toLocaleTimeString()}] Console initialized.`]);
  }, []);

  const addLog = (line: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${ts}] ${line}`, ...prev].slice(0, 120));
  };

  const connectWallet = async () => {
    try {
      if (!window.solana) {
        addLog("No wallet provider found. Install Phantom.");
        return;
      }
      const result = await window.solana.connect();
      const pubkey = result.publicKey.toString();
      setWallet(pubkey);
      setVerifyAddress(pubkey);
      addLog("Wallet connected.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      addLog(`Wallet connect failed: ${message}`);
    }
  };

  const onSubmitProof = (e: React.FormEvent) => {
    e.preventDefault();
    addLog(
      `Submit proof | source=${submitForm.source} score=${submitForm.score} nonce=${submitForm.nonce}`
    );
  };

  const onVerify = (e: React.FormEvent) => {
    e.preventDefault();
    const output = {
      user: verifyAddress,
      isVerified: connected,
      aggregatedScore: connected ? Number(submitForm.score || 0) : 0,
      verifiedAt: connected ? nowUnix() : 0,
    };
    setVerifyResult(JSON.stringify(output, null, 2));
    addLog(`Verify requested for ${verifyAddress || "(empty)"}.`);
  };

  const onRevoke = (e: React.FormEvent) => {
    e.preventDefault();
    addLog(`Revoke proof | source=${revokeForm.source}`);
  };

  const onRegistryUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    addLog(
      `Registry update | cooldown=${registryForm.cooldown} bonus=${registryForm.diversityBonus} ttl=${registryForm.ttl}`
    );
  };

  const onInitiateRotation = (e: React.FormEvent) => {
    e.preventDefault();
    addLog(
      `Verifier rotation initiated | verifier=${
        rotationForm.verifier || "(empty)"
      } delay=${rotationForm.delay}s`
    );
  };

  const onFinalizeRotation = () => {
    addLog("Verifier rotation finalize requested.");
  };

  return (
    <div className="root">
      <aside className="sidebar">
        <div className="logoRow">
          <span className="logoDot" />
          <div>
            <p className="logoTitle">SolanID</p>
            <p className="logoSub">Operator Console</p>
          </div>
        </div>

        <section className="panel tight">
          <p className="kicker">Wallet</p>
          <p className={`status ${connected ? "online" : "offline"}`}>
            {connected ? "Connected" : "Disconnected"}
          </p>
          <button className="btn primary full" onClick={connectWallet}>
            {connected ? "Reconnect" : "Connect Wallet"}
          </button>
          <p className="mono small break">{wallet || "No wallet connected"}</p>
        </section>

        <section className="panel tight">
          <p className="kicker">Network</p>
          <p>Localnet / Devnet</p>
          <p className="muted">Switch wallet endpoint as needed.</p>
        </section>
      </aside>

      <main className="main">
        <header className="hero panel">
          <h1>Proof Management</h1>
          <p>
            Submit, verify, revoke, and rotate verifier keys from a single dark
            control panel.
          </p>
        </header>

        <section className="grid two">
          <form className="panel" onSubmit={onSubmitProof}>
            <h2>Submit Proof</h2>
            <div className="fields twoCol">
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
                Nonce
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
            </div>

            <button className="btn primary">Submit Proof</button>
          </form>

          <div className="stack">
            <form className="panel" onSubmit={onVerify}>
              <h2>Verify Status</h2>
              <div className="fields oneCol">
                <label>
                  User Address
                  <input
                    value={verifyAddress}
                    onChange={(e) => setVerifyAddress(e.target.value)}
                  />
                </label>
              </div>
              <div className="row">
                <button className="btn">Check</button>
              </div>
              <pre className="result mono">{verifyResult}</pre>
            </form>

            <form className="panel" onSubmit={onRevoke}>
              <h2>Revoke Proof</h2>
              <div className="fields oneCol">
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
                    value={revokeForm.identityNullifier}
                    onChange={(e) =>
                      setRevokeForm((s) => ({
                        ...s,
                        identityNullifier: e.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <button className="btn danger">Revoke</button>
            </form>
          </div>
        </section>

        <section className="grid two">
          <form className="panel" onSubmit={onRegistryUpdate}>
            <h2>Registry Config</h2>
            <div className="fields oneCol">
              <label>
                Cooldown Seconds
                <input
                  value={registryForm.cooldown}
                  onChange={(e) =>
                    setRegistryForm((s) => ({ ...s, cooldown: e.target.value }))
                  }
                />
              </label>
              <label>
                Diversity Bonus %
                <input
                  value={registryForm.diversityBonus}
                  onChange={(e) =>
                    setRegistryForm((s) => ({
                      ...s,
                      diversityBonus: e.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Proof TTL Seconds
                <input
                  value={registryForm.ttl}
                  onChange={(e) =>
                    setRegistryForm((s) => ({ ...s, ttl: e.target.value }))
                  }
                />
              </label>
            </div>
            <button className="btn">Update Config</button>
          </form>

          <form className="panel" onSubmit={onInitiateRotation}>
            <h2>Verifier Rotation</h2>
            <div className="fields oneCol">
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
            </div>
            <div className="row">
              <button className="btn">Initiate</button>
              <button
                className="btn"
                type="button"
                onClick={onFinalizeRotation}
              >
                Finalize
              </button>
            </div>
          </form>
        </section>

        <section className="panel">
          <div className="logHeader">
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
      </main>
    </div>
  );
}
