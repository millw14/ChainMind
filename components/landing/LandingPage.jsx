"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  fadeScale,
  fadeUp,
  graphFloatTransition,
  staggerContainer,
  staggerParent,
  springGentle,
} from "@/components/motion/presets";

function useTypewriter(text, speed = 18, startDelay = 400, enabled = true) {
  const [displayed, setDisplayed] = useState(() => (enabled ? "" : text));
  useEffect(() => {
    if (!enabled) {
      setDisplayed(text);
      return;
    }
    setDisplayed("");
    let active = true;
    let intervalId;
    const timeoutId = setTimeout(() => {
      if (!active) return;
      let i = 0;
      intervalId = setInterval(() => {
        if (!active) return;
        i += 1;
        setDisplayed(text.slice(0, i));
        if (i >= text.length) clearInterval(intervalId);
      }, speed);
    }, startDelay);
    return () => {
      active = false;
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    };
  }, [text, speed, startDelay, enabled]);
  return displayed;
}

function TerminalCard({ reduce }) {
  const [visible, setVisible] = useState(false);
  const answer =
    "Active wallet holding 0.11 ETH. It recently sent WETH and several tokens to 8 different addresses — looks like a distribution wallet.";
  const typed = useTypewriter(answer, 16, 2600, !reduce);

  useEffect(() => {
    if (reduce) {
      setVisible(true);
      return;
    }
    const fadeTimer = setTimeout(() => setVisible(true), 2000);
    return () => clearTimeout(fadeTimer);
  }, [reduce]);

  return (
    <motion.div
      className="mt-3 max-h-[14rem] overflow-hidden text-[11px] leading-relaxed sm:text-xs"
      initial={{ opacity: 0 }}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.8 }}
    >
      <p className="font-mono text-[10px] uppercase tracking-wider text-cm-faint">You</p>
      <p className="mt-1 text-cm-subtle">What is 0x966C2F…8Ca79 doing?</p>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-cm-terminal">ChainMind</p>
      <p className="mt-1 text-cm-text">
        {reduce ? answer : typed}
        {!reduce && typed.length < answer.length && <span className="text-cm-accent">▋</span>}
      </p>
    </motion.div>
  );
}

const shell = "mx-auto w-full max-w-6xl px-3 sm:px-6";

function HeroGraphDecor({ reduce }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.65]" aria-hidden>
      <motion.svg
        className="absolute -right-8 top-8 h-72 w-72 text-cm-accent sm:right-12 sm:top-12 sm:h-96 sm:w-96"
        viewBox="0 0 200 200"
        animate={
          reduce
            ? {}
            : {
                y: [0, -10, 4, 0],
                rotate: [0, -1.5, 1.2, 0],
                scale: [1, 1.03, 1],
              }
        }
        transition={graphFloatTransition(reduce)}
      >
        <defs>
          <radialGradient id="hg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(16, 185, 129, 0.35)" />
            <stop offset="100%" stopColor="rgba(16, 185, 129, 0)" />
          </radialGradient>
        </defs>
        <motion.circle
          cx="100"
          cy="100"
          r="88"
          fill="url(#hg)"
          animate={reduce ? {} : { opacity: [0.85, 1, 0.9, 1] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => {
          const r = 72;
          const rad = (deg * Math.PI) / 180;
          const x = 100 + r * Math.cos(rad - Math.PI / 2);
          const y = 100 + r * Math.sin(rad - Math.PI / 2);
          return (
            <g key={deg}>
              <motion.line
                x1="100"
                y1="100"
                x2={x}
                y2={y}
                stroke="rgba(16, 185, 129, 0.28)"
                strokeWidth="0.75"
                animate={reduce ? {} : { opacity: [0.35, 0.85, 0.45] }}
                transition={{ duration: 3.2 + i * 0.25, repeat: Infinity, ease: "easeInOut", delay: i * 0.08 }}
              />
              <circle cx={x} cy={y} r={i % 2 === 0 ? 4 : 3} fill="rgba(244, 242, 248, 0.12)" stroke="rgba(16, 185, 129, 0.45)" strokeWidth="0.5" />
            </g>
          );
        })}
        <motion.circle
          cx="100"
          cy="100"
          r="10"
          fill="#10b981"
          animate={reduce ? {} : { scale: [1, 1.08, 1], opacity: [0.9, 1, 0.92] }}
          transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.circle
          cx="100"
          cy="100"
          r="16"
          fill="none"
          stroke="rgba(110, 231, 183, 0.4)"
          strokeWidth="0.75"
          animate={reduce ? {} : { scale: [1, 1.12, 1], opacity: [0.5, 0.95, 0.55] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
        />
      </motion.svg>
    </div>
  );
}

function CtaLink({ href, className, children }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      className="inline-flex"
      whileHover={reduce ? undefined : { y: -3, transition: springGentle }}
      whileTap={reduce ? undefined : { scale: 0.97 }}
      transition={{ type: "spring", stiffness: 450, damping: 22 }}
    >
      <Link href={href} className={className}>
        {children}
      </Link>
    </motion.div>
  );
}

export function LandingPage() {
  const reduceMotion = useReducedMotion() ?? false;
  const headlineText = "Ask anything on Robinhood Chain, get answers in plain English.";
  const typedHeadline = useTypewriter(headlineText, 28, 200, !reduceMotion);
  const fv = fadeUp(reduceMotion);
  const fs = fadeScale(reduceMotion);
  const scFast = staggerContainer(reduceMotion, { stagger: 0.065, delayChildren: 0.05 });

  /** Scroll-in choreography */
  const inViewOpts = { once: true, margin: "-60px", amount: 0.2 };

  return (
    <>
      <section className="relative overflow-x-clip border-b border-cm-border-subtle bg-cm-bg bg-cm-hero cm-war-grid cm-war-grid-motion">
        <HeroGraphDecor reduce={reduceMotion} />
        <div className={`relative ${shell} pb-20 pt-14 sm:pb-24 sm:pt-20`}>
          <motion.div
            className="relative grid grid-cols-1 gap-12 lg:grid-cols-[1fr,minmax(0,22rem)] lg:items-center lg:gap-16"
            initial="hidden"
            animate="show"
            variants={scFast}
          >
            <motion.div className="min-w-0" variants={staggerParent(reduceMotion, { stagger: 0.08, delayChildren: 0.02 })}>
              <motion.div variants={fv} className="inline-flex items-center gap-2 rounded border border-cm-border bg-cm-surface/80 px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-cm-terminal">
                <span className="cm-pulse-live inline-block h-1.5 w-1.5 rounded-full bg-cm-ok" />
                Robinhood Chain · AI explorer
              </motion.div>
              <motion.h1
                variants={fv}
                className="mt-6 max-w-3xl text-[1.75rem] font-semibold leading-[1.12] tracking-tight text-cm-text sm:text-4xl sm:leading-tight lg:text-[2.75rem]"
              >
                {reduceMotion ? headlineText : typedHeadline}
                {!reduceMotion && (
                  <motion.span
                    className="text-cm-accent"
                    animate={{ opacity: typedHeadline.length < headlineText.length ? [1, 0, 1] : [1, 0] }}
                    transition={{
                      duration: typedHeadline.length < headlineText.length ? 0.8 : 1.2,
                      repeat: typedHeadline.length < headlineText.length ? Infinity : 0,
                      delay: typedHeadline.length >= headlineText.length ? 0.8 : 0,
                    }}
                  >|</motion.span>
                )}
              </motion.h1>
              <motion.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: reduceMotion ? 0.2 : 2.2 }}
                className="mt-5 max-w-2xl text-base leading-relaxed text-cm-muted sm:text-lg"
              >
                ChainMind reads wallets, tokens, and transactions straight from the chain and explains what&apos;s
                happening. Just ask.
              </motion.p>
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: reduceMotion ? 0.3 : 2.8 }}
                className="mt-8 w-full min-w-0 max-w-full flex flex-col gap-3 md:max-w-xl"
              >
                <div className="flex flex-col gap-2">
                  <CtaLink
                    href="/ask"
                    className="inline-flex h-12 w-full items-center justify-center rounded-md bg-cm-accent px-8 text-base font-semibold text-cm-on-accent transition-colors hover:bg-cm-accent-bright active:bg-cm-accent-dim sm:w-auto sm:self-start"
                  >
                    Ask
                  </CtaLink>
                  <p className="text-xs text-cm-faint">No signup needed — start exploring Robinhood Chain.</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <CtaLink
                    href="/#how-it-works"
                    className="inline-flex h-9 items-center justify-center rounded-md border border-cm-border bg-cm-elevated/90 px-5 text-sm font-medium text-cm-text backdrop-blur-sm transition-colors hover:border-cm-accent/40 hover:bg-cm-row-hover"
                  >
                    How it works
                  </CtaLink>
                  <motion.div whileHover={{ x: 3 }} transition={springGentle}>
                    <Link
                      href="/docs"
                      className="inline-flex px-2 text-sm font-medium text-cm-muted underline-offset-4 hover:text-cm-text hover:underline sm:px-4"
                    >
                      Read the docs →
                    </Link>
                  </motion.div>
                </div>
              </motion.div>
            </motion.div>

            <motion.div variants={fs} className="relative">
              <motion.div
                className="cm-panel-edge cm-landing-card-glow rounded-md border border-cm-border bg-cm-card/95 p-4 shadow-cm backdrop-blur-sm sm:p-5"
                whileHover={reduceMotion ? {} : { scale: 1.02 }}
                transition={springGentle}
              >
                <div className="flex items-center justify-between border-b border-cm-border-subtle pb-3 font-mono text-[10px] uppercase tracking-wider text-cm-faint">
                  <motion.span animate={reduceMotion ? {} : { opacity: [0.7, 1, 0.75] }} transition={{ duration: 2.2, repeat: Infinity }}>
                    Ask · preview
                  </motion.span>
                  <span className="text-cm-terminal">wallet</span>
                </div>
                <TerminalCard reduce={reduceMotion} />
                <p className="mt-3 border-t border-cm-border-subtle pt-3 text-[11px] leading-snug text-cm-muted">
                  Every answer is grounded in live chain data—
                  <span className="text-cm-subtle"> open the evidence to see the exact rows behind it.</span>
                </p>
              </motion.div>
            </motion.div>
          </motion.div>

          <motion.div
            className="relative mt-16 grid grid-cols-1 gap-3 sm:mt-20 sm:grid-cols-3 sm:gap-4"
            initial="hidden"
            whileInView="show"
            viewport={inViewOpts}
            variants={staggerContainer(reduceMotion, { stagger: 0.12, delayChildren: 0.1 })}
          >
            {[
              {
                k: "Plain English",
                v: "Answers, not raw hex",
                sub: "Paste any address or transaction and get a human-readable explanation—balances, tokens, and what actually happened.",
              },
              {
                k: "Grounded in chain truth",
                v: "Live Blockscout data",
                sub: "Every answer is built from real on-chain reads, with the underlying evidence one click away. No made-up numbers.",
              },
              {
                k: "Anything on-chain",
                v: "Wallets · tokens · txns",
                sub: "Ask about a wallet's activity, a token's details, or exactly what a transaction did—all from one place.",
              },
            ].map((item) => (
              <motion.div
                key={item.k}
                variants={fadeScale(reduceMotion)}
                whileHover={
                  reduceMotion
                    ? {}
                    : {
                        y: -6,
                        boxShadow:
                          "0 0 0 1px rgba(16,185,129,0.4), 0 8px 32px -8px rgba(16,185,129,0.3)",
                        transition: springGentle,
                      }
                }
                className="cm-panel-edge border border-cm-border bg-cm-surface/90 p-4 sm:p-5"
              >
                <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-cm-faint">{item.k}</p>
                <p className="mt-2 text-sm font-semibold text-cm-text">{item.v}</p>
                <p className="mt-2 text-xs leading-relaxed text-cm-muted">{item.sub}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-16 border-b border-cm-border-subtle py-16 cm-war-grid cm-war-grid-motion sm:py-20">
        <div className={shell}>
          <motion.div
            className="max-w-2xl"
            initial="hidden"
            whileInView="show"
            viewport={inViewOpts}
            variants={staggerContainer(reduceMotion, { stagger: 0.09 })}
          >
            <motion.h2 variants={fadeUp(reduceMotion)} className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">
              From 0x to plain English
            </motion.h2>
            <motion.p variants={fadeUp(reduceMotion)} className="mt-2 text-sm leading-relaxed text-cm-muted sm:text-base">
              Three steps: paste a target, ChainMind reads it from the chain, and the AI explains it. More detail in the{" "}
              <Link href="/docs" className="font-medium text-cm-accent-bright underline-offset-4 hover:underline">
                Docs
              </Link>
              .
            </motion.p>
          </motion.div>

          <motion.ol
            className="mt-12 grid grid-cols-1 list-none gap-3 p-0 sm:grid-cols-3 lg:gap-4"
            initial="hidden"
            whileInView="show"
            viewport={inViewOpts}
            variants={staggerContainer(reduceMotion, { stagger: 0.11, delayChildren: 0.05 })}
          >
            {[
              { step: "01", title: "Paste a target", body: "Any Robinhood Chain address or transaction hash—no signup, no setup." },
              { step: "02", title: "We read the chain", body: "ChainMind pulls balances, tokens, transfers, and decoded activity live from Blockscout." },
              { step: "03", title: "AI explains it", body: "A grounded, plain-English answer to your question—with the raw evidence one click away." },
            ].map((item) => (
              <motion.li
                key={item.step}
                variants={fadeUp(reduceMotion)}
                whileHover={reduceMotion ? {} : { y: -5, transition: springGentle }}
                className="cm-panel-edge flex h-full flex-col border border-cm-border bg-cm-elevated/60 p-4 sm:p-5"
              >
                <span className="font-mono text-xs tabular-nums text-cm-accent-bright">{item.step}</span>
                <h3 className="mt-2 text-sm font-semibold text-cm-text">{item.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-cm-muted">{item.body}</p>
              </motion.li>
            ))}
          </motion.ol>

          {!reduceMotion && (
            <div className="mt-4 hidden lg:block">
              <motion.div
                className="h-px bg-gradient-to-r from-transparent via-cm-accent to-transparent"
                initial={{ scaleX: 0, opacity: 0 }}
                whileInView={{ scaleX: 1, opacity: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 1.2, ease: "easeInOut", delay: 0.6 }}
                style={{ transformOrigin: "left" }}
              />
            </div>
          )}

          <motion.p initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={inViewOpts} className="mt-10 text-xs text-cm-faint">
            <Link href="/how-it-works" className="font-medium text-cm-text underline-offset-4 hover:underline">
              How it fits together
            </Link>{" "}
            · What ChainMind can and can&apos;t answer.
          </motion.p>
        </div>
      </section>

      <section id="capabilities" className="scroll-mt-16 border-b border-cm-border-subtle py-16 sm:py-20">
        <div className={shell}>
          <motion.div
            className="max-w-2xl"
            initial="hidden"
            whileInView="show"
            viewport={inViewOpts}
            variants={staggerContainer(reduceMotion, { stagger: 0.08 })}
          >
            <motion.h2 variants={fadeUp(reduceMotion)} className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">
              Built for people, not parsers
            </motion.h2>
            <motion.p variants={fadeUp(reduceMotion)} className="mt-3 text-sm leading-relaxed text-cm-muted sm:text-base">
              Robinhood Chain brings tokenized stocks and real-world assets on-chain. ChainMind makes that activity
              legible to anyone—no need to read raw logs or decode calldata.
            </motion.p>
          </motion.div>
          <motion.div
            className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-5"
            initial="hidden"
            whileInView="show"
            viewport={inViewOpts}
            variants={staggerContainer(reduceMotion, { stagger: 0.12 })}
          >
            {[
              {
                t: "Conversational",
                d: "Ask follow-up questions in plain language. No query syntax, no filters to configure—just a chat.",
              },
              {
                t: "Evidence you can check",
                d: "Every answer ships with the exact on-chain rows it used, so you can verify instead of trust.",
              },
              {
                t: "Zero setup",
                d: "Open the explorer and paste an address. No wallet connection, no account, no install.",
              },
            ].map((x) => (
              <motion.article
                key={x.t}
                variants={fadeScale(reduceMotion)}
                whileHover={reduceMotion ? {} : { scale: 1.02, y: -4 }}
                transition={springGentle}
                className="cm-panel-edge flex h-full flex-col border border-cm-border bg-cm-surface p-5"
              >
                <h3 className="text-sm font-semibold text-cm-text">{x.t}</h3>
                <p className="mt-2 text-xs leading-relaxed text-cm-muted">{x.d}</p>
              </motion.article>
            ))}
          </motion.div>
        </div>
      </section>

      <section className="border-t border-cm-border-subtle bg-cm-surface/30 py-16 sm:py-20">
        <div className={shell}>
          <motion.div
            className="flex flex-col items-start justify-between gap-8 border border-cm-border bg-cm-elevated/50 px-6 py-8 sm:flex-row sm:items-center sm:px-10 sm:py-10"
            initial="hidden"
            whileInView="show"
            viewport={inViewOpts}
            variants={staggerContainer(reduceMotion, { stagger: 0.07 })}
          >
            <motion.div variants={fadeUp(reduceMotion)} className="max-w-xl">
              <h2 className="text-lg font-semibold text-cm-text sm:text-xl">Explore Robinhood Chain in plain English</h2>
              <p className="mt-2 text-sm leading-relaxed text-cm-muted">
                Paste any address or transaction and ask. Answers are grounded in live chain data—no signup required.
              </p>
            </motion.div>
            <motion.div variants={fadeUp(reduceMotion)} className="flex flex-shrink-0 flex-wrap gap-3">
              <motion.div
                animate={
                  reduceMotion
                    ? {}
                    : {
                        boxShadow: [
                          "0 0 20px -4px rgba(16,185,129,0.4)",
                          "0 0 36px -2px rgba(16,185,129,0.7)",
                          "0 0 20px -4px rgba(16,185,129,0.4)",
                        ],
                      }
                }
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                className="rounded-md"
              >
                <CtaLink
                  href="/ask"
                  className="inline-flex h-10 items-center justify-center rounded-md bg-cm-accent px-5 text-sm font-semibold text-cm-on-accent hover:bg-cm-accent-bright"
                >
                  Open the explorer
                </CtaLink>
              </motion.div>
              <CtaLink
                href="/docs"
                className="inline-flex h-10 items-center justify-center rounded-md border border-cm-border bg-cm-surface px-5 text-sm font-medium text-cm-text hover:bg-cm-row-hover"
              >
                Read the docs
              </CtaLink>
            </motion.div>
          </motion.div>
        </div>
      </section>
    </>
  );
}
