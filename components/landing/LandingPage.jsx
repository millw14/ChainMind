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
import { Reveal, Parallax } from "@/components/motion/scroll";
import GrainOverlay from "@/components/landing/GrainOverlay";
import EditorialHero from "@/components/landing/EditorialHero";
import HeroGridCanvas from "@/components/landing/HeroGridCanvas";
import FeatureStack from "@/components/landing/FeatureStack";

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

/** Points of the rising market line, in the 200x200 viewBox. */
const MARKET_PTS = [
  [8, 168],
  [38, 150],
  [64, 160],
  [92, 112],
  [118, 126],
  [148, 72],
  [174, 88],
  [194, 38],
];

function HeroGraphDecor({ reduce }) {
  const line = MARKET_PTS.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
  const area = `${line} L194,196 L8,196 Z`;
  const cx = MARKET_PTS.map((p) => p[0]);
  const cy = MARKET_PTS.map((p) => p[1]);
  const [endX, endY] = MARKET_PTS[MARKET_PTS.length - 1];

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.7]" aria-hidden>
      <motion.svg
        className="absolute -right-6 top-10 h-72 w-80 text-cm-accent sm:right-10 sm:top-14 sm:h-96 sm:w-[26rem]"
        viewBox="0 0 200 200"
        animate={reduce ? {} : { y: [0, -8, 0] }}
        transition={graphFloatTransition(reduce)}
      >
        <defs>
          <linearGradient id="marketArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(16, 185, 129, 0.28)" />
            <stop offset="100%" stopColor="rgba(16, 185, 129, 0)" />
          </linearGradient>
          <radialGradient id="dotGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(110, 231, 183, 0.5)" />
            <stop offset="100%" stopColor="rgba(110, 231, 183, 0)" />
          </radialGradient>
        </defs>

        {/* soft area fill beneath the line */}
        <motion.path
          d={area}
          fill="url(#marketArea)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1.6, delay: reduce ? 0 : 0.5 }}
        />

        {/* the rising line, drawn in */}
        <motion.path
          d={line}
          fill="none"
          stroke="#10b981"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: reduce ? 1 : 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 2.2, ease: "easeInOut" }}
          style={{ filter: "drop-shadow(0 0 6px rgba(16, 185, 129, 0.45))" }}
        />

        {/* dot tracing along the path */}
        {!reduce && (
          <>
            <motion.circle
              r="9"
              fill="url(#dotGlow)"
              initial={{ cx: cx[0], cy: cy[0] }}
              animate={{ cx, cy }}
              transition={{ duration: 5, ease: "linear", repeat: Infinity, repeatDelay: 0.6 }}
            />
            <motion.circle
              r="3.5"
              fill="#6ee7b7"
              initial={{ cx: cx[0], cy: cy[0] }}
              animate={{ cx, cy }}
              transition={{ duration: 5, ease: "linear", repeat: Infinity, repeatDelay: 0.6 }}
            />
          </>
        )}

        {/* resting endpoint marker (also the static state for reduced motion) */}
        <circle cx={endX} cy={endY} r="3.5" fill="#10b981" />
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
      <GrainOverlay opacity={0.05} />
      <EditorialHero />

      <section className="relative overflow-hidden border-b border-cm-border-subtle py-20 sm:py-28">
        <Parallax speed={-0.15} className="pointer-events-none absolute inset-0">
          <div aria-hidden className="cm-ambient-orb cm-ambient-orb--slow left-1/2 top-1/3 h-96 w-96 -translate-x-1/2 bg-cm-accent/10" />
        </Parallax>
        <div className={`relative ${shell}`}>
          <Reveal className="mx-auto max-w-3xl px-4 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cm-terminal">What you can do</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-cm-text sm:text-3xl">
              One question away from the whole chain
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-cm-muted sm:text-base">
              Every capability, in plain English — scroll through the stack.
            </p>
          </Reveal>
          <div className="mt-12 sm:mt-16">
            <FeatureStack />
          </div>
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
