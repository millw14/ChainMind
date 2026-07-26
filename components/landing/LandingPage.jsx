"use client";

import Link from "next/link";
import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  fadeScale,
  fadeUp,
  staggerContainer,
  springGentle,
} from "@/components/motion/presets";
import { Reveal } from "@/components/motion/scroll";
import GrainOverlay from "@/components/landing/GrainOverlay";
import EditorialHero from "@/components/landing/EditorialHero";
import Preloader from "@/components/landing/Preloader";
import CursorLayer from "@/components/landing/CursorLayer";
import CommandPill from "@/components/landing/CommandPill";
import ScrollDeck from "@/components/landing/ScrollDeck";
import HoverPreviewList from "@/components/landing/HoverPreviewList";
import ScrollFlipStage from "@/components/landing/ScrollFlipStage";
import ScrollTypeStatement from "@/components/landing/ScrollTypeStatement";
import AskOverlay from "@/components/landing/AskOverlay";

const shell = "mx-auto w-full max-w-6xl px-3 sm:px-6";

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
  const [askOpen, setAskOpen] = useState(false);

  /* NOTE: this component used to run a `useTypewriter` hook whose output was
     never rendered. It stepped a `setState` once every 28ms for the first two
     seconds after mount, re-rendering the whole landing tree ~70 times while the
     hero was still settling. Nothing below reads it, so it is gone; the same
     goes for the unused motion presets that were computed on every render. */

  /** Scroll-in choreography */
  const inViewOpts = { once: true, margin: "-60px", amount: 0.2 };

  return (
    <>
      <Preloader label="ChainMind" duration={1500} />
      <GrainOverlay opacity={0.05} />
      {/* Ambient bot cursors only — the visitor's own pointer is the OS one. */}
      <CursorLayer bots={[{ label: "ChainMind AI", color: "var(--cm-accent-bright)" }]} />
      <CommandPill href="/ask" label="Ask anything" onTrigger={() => setAskOpen(true)} />
      {/* No onSubmit: the overlay answers in place and keeps the follow-ups there. */}
      <AskOverlay open={askOpen} onClose={() => setAskOpen(false)} />

      {/* The hero rides on a board that hinges away in 3D as you scroll off it. */}
      <ScrollFlipStage>
        <EditorialHero />
      </ScrollFlipStage>

      <ScrollTypeStatement
        label="Statement 01"
        text="Every wallet, token and transaction on Robinhood Chain is public — but public is not the same as readable. ChainMind reads the ledger and tells you what it means."
        highlight={["readable", "what", "it", "means."]}
      />

      <section className="relative overflow-hidden border-b border-cm-border-subtle pb-10 pt-20 sm:pt-28">
        <div className={`relative ${shell}`}>
          <Reveal className="mx-auto max-w-3xl px-4 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cm-terminal">What you can do</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-cm-text sm:text-3xl">
              One question away from the whole chain
            </h2>
          </Reveal>
        </div>
        {/* Sticky 3D deck — each card pins for a viewport while the next rides over it. */}
        <div className="mt-14 sm:mt-20">
          <ScrollDeck />
        </div>
      </section>

      <section className="relative border-b border-cm-border-subtle py-20 sm:py-28">
        <div className={`relative ${shell}`}>
          <HoverPreviewList />
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
              From 0x to a read on it
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
              { step: "03", title: "AI explains it", body: "Figures first, then what they imply—supply, concentration, deployer—with the raw evidence one click away." },
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
              Robinhood Chain brings tokenized stocks and real-world assets on-chain. ChainMind pulls the figures and
              reads them—concentration, deployer, verification—without you decoding calldata for it.
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
              <h2 className="text-lg font-semibold text-cm-text sm:text-xl">Read Robinhood Chain properly</h2>
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
