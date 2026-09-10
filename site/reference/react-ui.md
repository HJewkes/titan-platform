# react-ui

**UI tier.** Published from a **different repository** —
[HJewkes/titan-design](https://github.com/HJewkes/titan-design), not this monorepo. It is
the fifteenth published `@titan-design/*` package and the only one whose source is not
under `packages/` here.

```sh
npm install @titan-design/react-ui
```

::: warning Documented from the outside
Every other page on this site was written against source in this repo and, where possible,
verified by running it. This one summarises another repository's README and manifest at
version 0.12.1. Treat that repo as authoritative and this page as a pointer.
:::

## What it is

A cross-platform design system built on React Native primitives with NativeWind (Tailwind
CSS), so components render on the web through `react-native-web` and natively on React
Native from one source. Dark theme by default, compound components in the Gluestack style,
TypeScript throughout.

Its peer dependencies say most of what you need to know about the commitment:
`react`, `react-dom`, `react-native`, `react-native-web`, `react-native-svg`, and
`nativewind`.

## Why it appears in this DAG

The platform audit named a "dashboard kit" as one of the tiers a product would want, and
`react-ui` already existed and was already published, so the tier points at it rather than
duplicating it.

The open question is a **split**: `react-ui` today mixes generic dashboard primitives with
components specific to one product's domain. Separating the generic half into a dashboard
kit is tracked as **TP-10** and has not happened yet, which is why the `ui` tier in
`.codewatch/check.json` is currently empty — no package in this repo occupies it.

## Status

Nothing in this monorepo depends on it yet. The session miner's dashboard is listed as
waiting on that split. When the split lands, this page should be replaced by a real
reference page for whatever package ends up in the `ui` tier here.
