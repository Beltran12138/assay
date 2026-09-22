#!/usr/bin/env tsx
/**
 * Evaluate the frozen release gates against observations already on disk.
 *
 *   npm run gates            evaluate and print the gate report
 *   npm run gates -- --stamp recompute the gate set hash after an intended edit
 *
 * No network, no judges, no cost: it reads `fixtures/runs/substitution-stage4.json`,
 * which is tracked, so the printed verdict is reproducible by anyone with the
 * repo and is checkable by hand against the numbers in FINDINGS #22.
 *
 * What it demonstrates is not a green build. On the current repo every blocking
 * gate comes back `unevaluable`, for three different reasons, and that is the
 * honest state of the evidence.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import {
  evaluateGates, formatGateReport, gateSetHash, loadGateSet, type GateSet,
} from '../lib/assay/gates'
import { buildReport } from '../lib/assay/report'
import type { Observation } from '../lib/assay/constructs'

const GATES = 'fixtures/gates/faithfulness-ladder.json'
const RUN = 'fixtures/runs/substitution-stage4.json'

type Stage4 = { judge: string; perCell: { cell: string; intact1: number | null; intact2: number | null }[] }[]

function stamp() {
  const raw = readFileSync(GATES, 'utf8')
  const d = JSON.parse(raw) as GateSet
  const h = gateSetHash(d.gates)
  if (h === d.hash) { console.log(`already stamped: ${h}`); return }
  writeFileSync(GATES, raw.replace(/"hash": "[^"]*"/, `"hash": "${h}"`))
  console.log(`${d.hash} → ${h}\n⚠️ a bar moved. Update "frozenAt" in the same commit.`)
}

/** The intact-context faithfulness cells, as observations. Nothing is invented:
 *  `generator` comes from the cell id and `judge` from the run, which is what
 *  lets the self-grading check fire on the third of the cells where they match. */
function intactObservations(): Observation[] {
  const run = JSON.parse(readFileSync(RUN, 'utf8')) as Stage4
  const out: Observation[] = []
  for (const j of run) {
    for (const c of j.perCell) {
      for (const s of [c.intact1, c.intact2]) {
        if (typeof s !== 'number') continue // unreadable ≠ zero — FINDINGS #4
        out.push({
          construct: 'faithfulness',
          method: 'llm_judge',
          score: s,
          generator: c.cell.split('#')[0],
          judge: j.judge,
          source: `${RUN}:${c.cell}`,
        })
      }
    }
  }
  return out
}

function main() {
  if (process.argv.includes('--stamp')) return stamp()

  const gateSet = loadGateSet(JSON.parse(readFileSync(GATES, 'utf8')))
  const observations = intactObservations()
  const report = buildReport(observations)

  console.log(`observations: ${observations.length} (intact rung, ${RUN})`)
  console.log(`report flags: ${report.flags.map(f => f.code).join(', ') || '(none)'}\n`)
  console.log(formatGateReport(evaluateGates(gateSet, observations, report.flags)))
}

main()
