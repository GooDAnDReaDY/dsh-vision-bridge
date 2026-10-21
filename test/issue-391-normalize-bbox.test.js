import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBbox } from '../lib/image-processing.js'

describe('Issue #391: normalizeBbox Units and Axis Consistency', () => {
  it('Issue #391: reproduces exact expected coordinates for 800x600 and 2000x1500 images', () => {
    // 800x600 resolution (sub-1000px dimension)
    // [100, 200, 500, 600] scaled by (800/1000, 600/1000)
    const bbox800 = normalizeBbox([100, 200, 500, 600], 800, 600)
    assert.deepEqual(bbox800, [80, 120, 400, 360])

    // 2000x1500 resolution (super-1000px dimension)
    // [100, 200, 500, 600] scaled by (2000/1000, 1500/1000)
    const bbox2000 = normalizeBbox([100, 200, 500, 600], 2000, 1500)
    assert.deepEqual(bbox2000, [200, 300, 1000, 900])
  })

  it('keeps area proportion invariant below and above 1000px', () => {
    const raw = [250, 200, 750, 800] // dx=500/1000=0.5, dy=600/1000=0.6

    const bSub = normalizeBbox(raw, 500, 400)
    assert.equal((bSub[2] - bSub[0]) / 500, 0.5)
    assert.equal((bSub[3] - bSub[1]) / 400, 0.6)

    const bSuper = normalizeBbox(raw, 3000, 2000)
    assert.equal((bSuper[2] - bSuper[0]) / 3000, 0.5)
    assert.equal((bSuper[3] - bSuper[1]) / 2000, 0.6)
  })

  it('supports normalized 0..1 scale correctly', () => {
    const b = normalizeBbox([0.1, 0.2, 0.5, 0.6], 800, 600)
    assert.deepEqual(b, [80, 120, 400, 360])
  })

  it('supports explicit pixel units without 0..1000 scaling', () => {
    const bObj = normalizeBbox({ x: 50, y: 60, width: 200, height: 100, unit: 'pixel' }, 1000, 1000)
    assert.deepEqual(bObj, [50, 60, 250, 160])

    const bOpt = normalizeBbox([100, 200, 500, 600], 2000, 1500, { unit: 'pixel' })
    assert.deepEqual(bOpt, [100, 200, 500, 600])
  })

  it('clamps coordinates to image boundaries and handles inverted coords', () => {
    const inverted = normalizeBbox([800, 900, 100, 200], 1000, 1000)
    assert.deepEqual(inverted, [100, 200, 800, 900])

    const outOfBounds = normalizeBbox([-500, -500, 2000, 2000], 1000, 1000)
    assert.deepEqual(outOfBounds, [0, 0, 1000, 1000])
  })
})
