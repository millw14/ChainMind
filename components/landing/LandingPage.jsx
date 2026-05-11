"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

const shell = "mx-auto w-full max-w-6xl px-4 sm:px-6";

const easeOut = [0.22, 1, 0.36, 1];

function Pill({ children, variants, reduced }) {
  return (
    <motion.span
      variants={variants}
      className={`inline-flex items-center rounded-full border border-cm-accent/20 bg-cm-accent/10 px-3 py-1 text-xs font-medium text-cm-accent-bright ${reduced ? "" : "cm-pill-pulse"}`}
    >
      {children}
    </motion.span>
  );
}

function CtaLink({ href, className, children, reduceMotion }) {
  return (
    <motion.div
      className="w-full sm:w-auto"
      whileHover={reduceMotion ? undefined : { scale: 1.06, y: -4 }}
      whileTap={reduceMotion ? undefined : { scale: 0.97 }}
      transition={{ type: "spring", stiffness: 380, damping: 20 }}
    >
      <Link href={href} className={className}>
        {children}
      </Link>
    </motion.div>
  );
}

export function LandingPage() {
  const reduceMotion = useReducedMotion();

  const stagger = {
    hidden: {},
    visible: {
      transition: {
        staggerChildren: reduceMotion ? 0 : 0.14,
        delayChildren: reduceMotion ? 0 : 0.1,
      },
    },
  };

  const fadeUp = {
    hidden: { opacity: 0, y: reduceMotion ? 0 : 48 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: reduceMotion ? 0.22 : 0.78, ease: easeOut },
    },
  };

  const sectionBlock = {
    hidden: { opacity: 0, y: reduceMotion ? 0 : 56 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: reduceMotion ? 0.22 : 0.72,
        ease: easeOut,
        staggerChildren: reduceMotion ? 0 : 0.12,
        delayChildren: reduceMotion ? 0 : 0.08,
      },
    },
  };

  const cardHover = reduceMotion
    ? {}
    : {
        y: -10,
        transition: { type: "spring", stiffness: 360, damping: 22 },
      };

  const cardHighlight = reduceMotion
    ? {}
    : {
        boxShadow:
          "0 0 0 1px rgba(167, 139, 250, 0.2), 0 24px 48px -18px rgba(0, 0, 0, 0.55)",
      };

  return (
    <>
      <section className="relative overflow-hidden border-b border-cm-border-subtle bg-cm-bg bg-cm-hero cm-hero-live">
        <div className={`relative z-[1] ${shell} pb-20 pt-14 sm:pb-28 sm:pt-20`}>
          <motion.div
            className="mx-auto max-w-2xl text-center"
            variants={stagger}
            initial="hidden"
            animate="visible"
          >
            <Pill variants={fadeUp} reduced={Boolean(reduceMotion)}>
              Solana · on-chain analytics
            </Pill>
            <motion.h1
              variants={fadeUp}
              className="mt-6 text-4xl font-bold tracking-tight text-cm-text sm:text-5xl sm:leading-tight"
            >
              RPC checks, address history, and optional co-activity scores
            </motion.h1>
            <motion.p variants={fadeUp} className="mt-6 text-lg leading-relaxed text-cm-muted">
              ChainMind reads your Solana RPC for live status and recent signatures. Add the CLI and a synced database
              when you need windowed co-activity metrics. Outputs support analysis; they do not establish intent or
              wrongdoing.
            </motion.p>
            <motion.div
              variants={fadeUp}
              className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center sm:justify-center"
            >
              <CtaLink
                href="/console"
                reduceMotion={reduceMotion}
                className="inline-flex h-12 items-center justify-center rounded-xl bg-cm-accent px-8 text-sm font-semibold text-cm-on-accent transition-colors duration-200 hover:bg-cm-accent-bright sm:min-w-[10rem]"
              >
                Open console
              </CtaLink>
              <CtaLink
                href="/#how-it-works"
                reduceMotion={reduceMotion}
                className="inline-flex h-12 items-center justify-center rounded-xl border border-cm-border bg-cm-elevated/50 px-8 text-sm font-semibold text-cm-text transition-colors duration-200 hover:border-cm-faint hover:bg-cm-row-hover/40 sm:min-w-[10rem]"
              >
                How it works
              </CtaLink>
            </motion.div>
          </motion.div>

          <motion.div
            className="mt-16 grid gap-4 sm:mt-20 sm:grid-cols-3 sm:gap-5"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.2, margin: "-40px 0px" }}
            variants={stagger}
          >
            {[
              {
                k: "RPC health",
                v: "Slot, version, cluster",
                sub: "Baselines from your endpoint before you trust the rest.",
              },
              {
                k: "Address history",
                v: "Signatures and Solscan links",
                sub: "Wallet, mint, or program id in one table.",
              },
              {
                k: "Optional scoring",
                v: "CLI sync and Turso",
                sub: "v1 co-activity when your events are in the database.",
              },
            ].map((item) => (
              <motion.div
                key={item.k}
                variants={fadeUp}
                whileHover={{ ...cardHover, ...cardHighlight }}
                className="flex h-full flex-col rounded-2xl border border-cm-border bg-cm-card/50 p-5 text-left backdrop-blur-sm transition-colors duration-300 hover:border-cm-accent/25"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-cm-accent-bright/90">{item.k}</p>
                <p className="mt-2 font-semibold text-cm-text">{item.v}</p>
                <p className="mt-2 text-sm leading-relaxed text-cm-faint">{item.sub}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-20 border-b border-cm-border-subtle py-16 sm:py-20">
        <motion.div
          className={shell}
          variants={sectionBlock}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.15, margin: "-60px 0px" }}
        >
          <motion.div className="max-w-2xl" variants={fadeUp}>
            <h2 className="text-2xl font-bold tracking-tight text-cm-text sm:text-3xl">How it works</h2>
            <p className="mt-3 text-base leading-relaxed text-cm-muted">
              If you are new here: four steps from login to a score. No account required for RPC and address lookup.
            </p>
          </motion.div>

          <motion.ol
            className="mt-12 grid list-none gap-6 p-0 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5"
            variants={stagger}
          >
            {[
              {
                step: "1",
                title: "Open the console",
                body: "Point ChainMind at your RPC (environment on the host). Run a ping to confirm slot and version.",
              },
              {
                step: "2",
                title: "Inspect an address",
                body: "Paste a base58 address: wallet, token mint, or program. Load recent signatures and open Solscan from the table.",
              },
              {
                step: "3",
                title: "Sync your data",
                body: "Use the CLI to backfill signatures, parse events, and push to Turso if you want cloud-backed counts.",
              },
              {
                step: "4",
                title: "Run a score",
                body: "With data connected, set a scope, window, and lookback. v1 returns peak distinct fee payers in a bucket, with caveats.",
              },
            ].map((item) => (
              <motion.li
                key={item.step}
                variants={fadeUp}
                whileHover={cardHover}
                className="flex h-full flex-col rounded-xl border border-cm-border bg-cm-elevated/25 p-5 transition-colors duration-300 hover:border-cm-accent/20 sm:p-6"
              >
                <motion.span
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-cm-accent/15 text-sm font-semibold text-cm-accent-bright"
                  aria-hidden
                  whileHover={reduceMotion ? undefined : { scale: 1.06 }}
                  transition={{ type: "spring", stiffness: 400, damping: 18 }}
                >
                  {item.step}
                </motion.span>
                <h3 className="mt-4 font-semibold text-cm-text">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-cm-muted">{item.body}</p>
              </motion.li>
            ))}
          </motion.ol>

          <motion.p variants={fadeUp} className="mt-10 text-sm text-cm-faint">
            <Link
              href="/how-it-works"
              className="font-medium text-cm-accent-bright underline-offset-4 transition-colors hover:text-cm-accent hover:underline"
            >
              Read the full guide
            </Link>{" "}
            for pipeline detail and score definitions.
          </motion.p>
        </motion.div>
      </section>

      <section id="capabilities" className="scroll-mt-20 border-b border-cm-border-subtle py-16 sm:py-24">
        <motion.div
          className={shell}
          variants={sectionBlock}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.12, margin: "-40px 0px" }}
        >
          <motion.div className="max-w-2xl" variants={fadeUp}>
            <h2 className="text-2xl font-bold tracking-tight text-cm-text sm:text-3xl">Capabilities</h2>
            <p className="mt-4 text-base leading-relaxed text-cm-muted">
              Start with the hosted console only. Add the pipeline when you need metrics derived from your own event
              store, not generic block explorers alone.
            </p>
          </motion.div>
          <motion.div className="mt-12 grid gap-6 md:grid-cols-3 md:gap-8" variants={stagger}>
            <motion.article
              variants={fadeUp}
              whileHover={{ ...cardHover, ...cardHighlight }}
              className="flex h-full flex-col rounded-2xl border border-cm-border bg-cm-elevated/40 p-6 transition-colors duration-300 hover:border-cm-accent/20"
            >
              <h3 className="text-lg font-semibold text-cm-text">Network checks</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                Confirms your RPC responds with current slot, software version, and cluster. Use it before relying on any
                downstream number.
              </p>
            </motion.article>
            <motion.article
              variants={fadeUp}
              whileHover={{ ...cardHover, ...cardHighlight }}
              className="flex h-full flex-col rounded-2xl border border-cm-border bg-cm-elevated/40 p-6 transition-colors duration-300 hover:border-cm-accent/20"
            >
              <h3 className="text-lg font-semibold text-cm-text">Per-address ledger lookback</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                Fetches recent signatures for a single address. Results are shown in a compact table with outbound links
                for each transaction.
              </p>
            </motion.article>
            <motion.article
              variants={fadeUp}
              whileHover={{ ...cardHover, ...cardHighlight }}
              className="flex h-full flex-col rounded-2xl border border-cm-border bg-cm-elevated/40 p-6 transition-colors duration-300 hover:border-cm-accent/20"
            >
              <h3 className="text-lg font-semibold text-cm-text">Co-activity (v1)</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                With synced events: maximum count of distinct fee-paying wallets in one time bucket over your lookback.
                Calibrate on liquid tokens and your RPC limits before you trust the headline.
              </p>
            </motion.article>
          </motion.div>
        </motion.div>
      </section>

      <section className="relative overflow-hidden bg-cm-bg bg-cm-footer py-16 sm:py-20">
        {!reduceMotion ? (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-cm-accent/5 to-transparent"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1.2, ease: easeOut }}
          />
        ) : null}
        <motion.div
          className={`relative z-[1] ${shell}`}
          variants={sectionBlock}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.25 }}
        >
          <motion.div
            variants={fadeUp}
            className="max-w-3xl rounded-2xl border border-cm-border bg-cm-elevated/30 px-6 py-9 sm:px-10 sm:py-11"
            whileHover={reduceMotion ? undefined : { borderColor: "rgba(167, 139, 250, 0.28)" }}
            transition={{ duration: 0.25 }}
          >
            <h2 className="text-xl font-bold text-cm-text sm:text-2xl">Limits</h2>
            <p className="mt-4 text-sm leading-relaxed text-cm-muted sm:text-base">
              Public RPCs throttle; busy mints skew timing windows. Co-activity is a concentration statistic over
              windows you configure. It is not proof of coordination in a legal sense. Use a dedicated RPC and your own
              sync for anything production-grade.
            </p>
            <CtaLink
              href="/console"
              reduceMotion={reduceMotion}
              className="mt-8 inline-flex h-11 items-center justify-center rounded-xl bg-cm-accent px-6 text-sm font-semibold text-cm-on-accent transition-colors duration-200 hover:bg-cm-accent-bright"
            >
              Open console
            </CtaLink>
          </motion.div>
        </motion.div>
      </section>
    </>
  );
}
