/**
 * Talking to whatever wallet the browser has, with no wallet library.
 *
 * WHY NO LIBRARY. wagmi/RainbowKit/WalletConnect would each add a dependency tree
 * larger than this entire app to do one thing we can do with two RPC calls:
 * `eth_requestAccounts` and `personal_sign`. Everything else the gate needs
 * happens on the server. Five runtime dependencies is a feature of this codebase,
 * not an accident.
 *
 * THE ONLY TWO METHODS THIS FILE MAY EVER CALL that touch the user's keys are
 * `eth_requestAccounts` (which asks for an address) and `personal_sign` (which
 * signs text). There is no `eth_sendTransaction`, no `eth_signTypedData`, no
 * `wallet_watchAsset`, no approval, no permit — and there must never be. A sign-in
 * prompt is exactly where a user has been trained to click through, so the only
 * thing this app is allowed to put in front of them is a message that cannot move
 * anything. `wallet_switchEthereumChain` is the one other method here; it changes
 * which network the wallet is pointed at and moves no funds.
 *
 * DISCOVERY IS EIP-6963 FIRST. Two extensions both writing `window.ethereum` is
 * the normal case now, and the last one to load wins — which is how a user ends up
 * signing with a wallet they did not pick. The announcement protocol names them
 * all; `window.ethereum` is kept only as the fallback for wallets that have not
 * adopted it.
 */

/** How long to listen for wallet announcements. They answer synchronously. */
const DISCOVERY_MS = 250;

/**
 * Every injected provider that announces itself, plus `window.ethereum` if it did
 * not.
 *
 * @returns {Promise<Array<{ id: string, name: string, icon: string|null, provider: object }>>}
 */
export function discoverProviders() {
  if (typeof window === "undefined") return Promise.resolve([]);

  return new Promise((resolve) => {
    const found = new Map();

    const onAnnounce = (event) => {
      const detail = event?.detail;
      const info = detail?.info;
      const provider = detail?.provider;
      if (!info?.uuid || !provider || typeof provider.request !== "function") return;
      found.set(info.uuid, {
        id: info.uuid,
        name: String(info.name ?? "Wallet"),
        icon: typeof info.icon === "string" ? info.icon : null,
        provider,
      });
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    try {
      window.dispatchEvent(new Event("eip6963:requestProvider"));
    } catch {
      // An environment without CustomEvent semantics still gets the fallback.
    }

    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const list = [...found.values()];
      const legacy = window.ethereum;
      // Only when nothing announced: a wallet that did announce is already in the
      // list, and adding window.ethereum again would offer it twice under a name
      // we would have to guess.
      if (!list.length && legacy && typeof legacy.request === "function") {
        list.push({ id: "injected", name: walletName(legacy), icon: null, provider: legacy });
      }
      resolve(list);
    }, DISCOVERY_MS);
  });
}

/** A best-effort name for a legacy provider, for the button label only. */
function walletName(provider) {
  if (provider?.isRabby) return "Rabby";
  if (provider?.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider?.isBraveWallet) return "Brave Wallet";
  if (provider?.isMetaMask) return "MetaMask";
  return "Browser wallet";
}

/** UTF-8 as `0x…` hex — the shape personal_sign is specified to take. */
export function toHexUtf8(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let out = "0x";
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Ask for an address.
 *
 * @param {object} provider
 * @returns {Promise<string>} the first account, lowercased by most wallets
 */
export async function requestAddress(provider) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const first = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) {
    throw new Error("That wallet did not return an address.");
  }
  return first;
}

/** Accounts already connected, without prompting. Used to render "connect" honestly. */
export async function silentAddress(provider) {
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    const first = Array.isArray(accounts) ? accounts[0] : null;
    return typeof first === "string" && /^0x[0-9a-fA-F]{40}$/.test(first) ? first : null;
  } catch {
    return null;
  }
}

/** The wallet's current chain id as a number, or null when it will not say. */
export async function currentChainId(provider) {
  try {
    const hex = await provider.request({ method: "eth_chainId" });
    const n = Number.parseInt(String(hex), 16);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Sign a message. Text in, signature out, and nothing else can happen.
 *
 * @param {object} provider
 * @param {string} address
 * @param {string} message
 * @returns {Promise<string>} 0x-prefixed 65-byte signature
 */
export async function signMessage(provider, address, message) {
  const signature = await provider.request({
    method: "personal_sign",
    params: [toHexUtf8(message), address],
  });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error("That wallet returned a signature we could not read.");
  }
  return signature;
}

/**
 * Point the wallet at a chain.
 *
 * Offered, never required: `personal_sign` works whatever network the wallet is
 * on, and the balance behind the gate is read by the SERVER on chain 4663 no
 * matter where the user's wallet happens to be pointed. This exists so the
 * explorer and the wallet agree about which chain is being talked about.
 *
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function switchChain(provider, chainId) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${Number(chainId).toString(16)}` }],
    });
    return { ok: true };
  } catch (e) {
    // 4902: the wallet does not know this network. Adding it needs RPC and
    // explorer URLs we would be asking the user to trust from a web page, so the
    // honest move is to tell them to add it themselves.
    if (e?.code === 4902) {
      return { ok: false, error: "Your wallet does not have Robinhood Chain yet — add it there first." };
    }
    return { ok: false, error: walletError(e, "Could not switch network.") };
  }
}

/**
 * A wallet error as a sentence.
 *
 * 4001 is the one that matters: the user said no, which is an ordinary answer and
 * must never be dressed up as a failure. Nothing was sent and nothing moved.
 */
export function walletError(error, fallback = "Something went wrong talking to your wallet.") {
  const code = error?.code;
  if (code === 4001 || code === "ACTION_REJECTED") {
    return "You declined the signature. Nothing was sent, and nothing moved.";
  }
  if (code === -32002) {
    return "Your wallet already has a request open — finish it there, then try again.";
  }
  const message = String(error?.message ?? "").trim();
  return message ? message.slice(0, 200) : fallback;
}
