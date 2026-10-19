import { describe, expect, it } from 'bun:test';
import { createErrorLedger } from '../errorLedger';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('gui error ledger', () => {
  it('batches records in the same cascade into one sink call', async () => {
    const batches: string[][] = [];
    const ledger = createErrorLedger({ sink: async lines => void batches.push(lines) });
    ledger.record({ kind: 'error', message: 'boom', line: 1, column: 2, stack: 's1' });
    ledger.record({ kind: 'unhandledrejection', message: 'rej' });
    await sleep(10);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(2);
    expect(JSON.parse(batches[0][0])).toMatchObject({ kind: 'error', message: 'boom', line: 1, column: 2 });
    expect(JSON.parse(batches[0][1])).toMatchObject({ kind: 'unhandledrejection', message: 'rej' });
  });

  it('keeps the EARLIEST errors when a cascade overflows the cap', () => {
    const seen: string[][] = [];
    const ledger = createErrorLedger({ sink: lines => void seen.push(lines) });
    for (let i = 0; i < 60; i++) ledger.record({ kind: 'error', message: `e${i}` });
    expect(ledger.pendingCount()).toBe(50);
    ledger.flush();
    const parsed = seen[0].map(l => JSON.parse(l).message);
    expect(parsed[0]).toBe('e0');
    expect(parsed[49]).toBe('e49');
  });

  it('truncates oversized stack fields', async () => {
    const seen: string[][] = [];
    const ledger = createErrorLedger({ sink: lines => void seen.push(lines) });
    ledger.record({ kind: 'error', message: 'm', stack: 'x'.repeat(9000) });
    await sleep(10);
    const parsed = JSON.parse(seen[0][0]);
    expect(parsed.stack.length).toBe(4000);
  });

  it('a failing sink never throws and later batches still flush', async () => {
    let fail = true;
    const batches: string[][] = [];
    const ledger = createErrorLedger({
      sink: async lines => {
        if (fail) throw new Error('bridge down');
        batches.push(lines);
      },
    });
    ledger.record({ kind: 'error', message: 'first' });
    await sleep(10); // 第一批:静默失败
    expect(batches.length).toBe(0);
    fail = false;
    ledger.record({ kind: 'error', message: 'second' });
    await sleep(10);
    expect(batches.length).toBe(1);
    expect(JSON.parse(batches[0][0]).message).toBe('second');
  });
});
