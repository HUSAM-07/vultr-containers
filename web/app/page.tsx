import { RiArrowRightLine, RiBookOpenLine, RiGitPullRequestLine, RiGithubFill, RiSparkling2Line } from "@remixicon/react";
import Link from "next/link";
import { ButtonLink } from "@/components/base/buttons/button";

const steps = [
  { icon: RiGithubFill, title: "Connect your repository", body: "Choose a GitHub repository that you already own or contribute to. Fava reads its structure and project instructions." },
  { icon: RiBookOpenLine, title: "Write the source of truth", body: "Describe the outcome, scope, and acceptance criteria in plain English. Save the spec in the repository as a pull request." },
  { icon: RiGitPullRequestLine, title: "Merge before implementation", body: "The spec PR is the review gate. Agent work follows the merged specification, with its code and evidence attached to a separate PR." },
];

export default function LandingPage() {
  return <main className="min-h-dvh bg-background-full text-text-primary">
    <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6">
      <Link href="/" className="flex items-center gap-3 text-title-3-semibold"><span className="grid size-9 place-items-center rounded-xl bg-accent-600 text-background-primary-default">F</span>Fava</Link>
      <nav className="flex items-center gap-3" aria-label="Primary">
        <a href="/demo" className="hidden text-body-medium text-text-secondary hover:text-text-primary sm:block">Forge demo</a>
        <ButtonLink href="/app" trailingIcon={RiArrowRightLine} size="small">Open workspace</ButtonLink>
      </nav>
    </header>

    <section className="mx-auto grid max-w-7xl gap-12 px-6 pb-16 pt-14 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:pb-28 lg:pt-24">
      <div className="max-w-2xl">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border-button-default bg-background-secondary-default px-3 py-1.5 text-caption-1-semibold text-text-secondary"><RiSparkling2Line className="size-4 text-accent-600" aria-hidden />Spec-first software building</div>
        <h1 className="text-[clamp(3.2rem,7vw,6.3rem)] font-semibold leading-[1.02] tracking-[-.07em]">Ideas become specs.<br /><span className="text-accent-600">Specs become software.</span></h1>
        <p className="mt-7 max-w-xl text-headline-regular text-text-secondary">Connect a repository, understand what exists, and write the next change in human language. GitHub keeps the specification and its history.</p>
        <div className="mt-9 flex flex-wrap items-center gap-3"><ButtonLink href="/app" trailingIcon={RiArrowRightLine}>Start a specification</ButtonLink><ButtonLink href="/demo" variant="secondary">Explore the agent demo</ButtonLink></div>
        <p className="mt-4 text-caption-1-regular text-text-tertiary">GitHub connection requires the Fava GitHub App to be configured.</p>
      </div>
      <div className="relative rounded-3xl border border-border-button-default bg-background-secondary-default p-4 shadow-lg sm:p-6">
        <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-5 sm:p-7">
          <div className="flex items-center justify-between border-b border-separator-border pb-5"><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-accent-100 text-accent-700"><RiBookOpenLine className="size-5" aria-hidden /></span><div><p className="text-body-medium">Product specification</p><p className="text-caption-1-regular text-text-tertiary">specs/new-project.md</p></div></div><span className="rounded-full bg-background-tertiary-default px-3 py-1 text-caption-1-semibold text-text-secondary">Draft</span></div>
          <div className="space-y-5 py-6"><div><p className="text-caption-1-semibold uppercase tracking-widest text-text-tertiary">Outcome</p><p className="mt-2 text-body-regular text-text-secondary">What should be true for the person using this product?</p></div><div><p className="text-caption-1-semibold uppercase tracking-widest text-text-tertiary">Scope</p><p className="mt-2 text-body-regular text-text-secondary">The behavior to build, and the boundaries to respect.</p></div><div><p className="text-caption-1-semibold uppercase tracking-widest text-text-tertiary">Acceptance criteria</p><p className="mt-2 text-body-regular text-text-secondary">Observable evidence that the work is complete.</p></div></div>
          <div className="flex items-center gap-2 border-t border-separator-border pt-5 text-body-medium text-text-secondary"><RiGitPullRequestLine className="size-5 text-accent-600" aria-hidden />Review the intent on GitHub before code runs</div>
        </div>
      </div>
    </section>

    <section className="border-t border-separator-border bg-background-secondary-default"><div className="mx-auto max-w-7xl px-6 py-16"><p className="text-caption-1-semibold uppercase tracking-widest text-accent-600">The workflow</p><h2 className="mt-3 text-title-1-medium">A clear contract for every change</h2><div className="mt-9 grid gap-4 md:grid-cols-3">{steps.map((step, index) => <article key={step.title} className="rounded-3xl border border-border-button-default bg-background-primary-default p-6"><step.icon className="size-6 text-accent-600" aria-hidden /><p className="mt-5 text-caption-1-semibold text-text-tertiary">0{index + 1}</p><h3 className="mt-2 text-title-3-semibold">{step.title}</h3><p className="mt-3 text-body-regular text-text-secondary">{step.body}</p></article>)}</div></div></section>
  </main>;
}
