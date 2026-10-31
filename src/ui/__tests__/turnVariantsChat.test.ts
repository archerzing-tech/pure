// src/ui/__tests__/turnVariantsChat.test.ts
// Reply-variant wiring inside chat.ts, pinned as source contracts (the
// chat.test.ts house style): the skipUserPersist gates that keep a
// regenerated turn from double-recording the user's words, the ledger sync
// that rides every persist, the snapshot round-trip, and the manager-level
// forwarding main.ts drives. Pure readFileSync — no chat import, immune to
// the cross-file mock landmine.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (url: URL): string => readFileSync(url, 'utf8');

describe('turn variants · chat.ts wiring', () => {
  const src = readSource(new URL('../chat.ts', import.meta.url));

  it('regenerating never re-records the user_input event or re-draws the user bubble', () => {
    // user_input 是 append-only 审计流水:重生成跑的是同一句话,账上已有,
    // 重记一遍就是同一问两份输入史。气泡同理——它还挂在屏上。
    const gate = src.indexOf('if (!opts.skipUserPersist) {');
    expect(gate).toBeGreaterThan(-1);
    const gateBody = src.slice(gate, gate + 400);
    expect(gateBody).toContain("kind: 'user_input'");
    // 渲染行三元的 skipUserBubble 分支是插话重入静默化（2026-10-27）：
    // 残留 steer 重入只补历史账不重画气泡——同一条纪律，两处闸门。
    const bubble = src.indexOf("const userBubble = opts.skipUserPersist || opts.skipUserBubble ? null : this.addBubble('user', userText);");
    expect(bubble).toBeGreaterThan(-1);
  });

  it('regenerateLastTurn truncates to the last user turn, prunes the DOM tail, and re-sends with skipUserPersist', () => {
    const method = src.indexOf('async regenerateLastTurn(): Promise<void> {');
    expect(method).toBeGreaterThan(-1);
    const body = src.slice(method, src.indexOf('async editLastTurn', method));
    expect(body).toContain('if (this.streaming) return;');
    expect(body).toContain('lastUserTurnStart(this.messages)');
    expect(body).toContain('this.adoptTurnVariantLedger(');
    expect(body).toContain('this.messages = this.messages.slice(0, start);');
    expect(body).toContain('this.pruneTranscriptAfterLastUserBubble()');
    expect(body).toContain('skipUserPersist: true');
  });

  it('editLastTurn records the edited text as a NEW user_input — an edit is a new sentence', () => {
    const method = src.indexOf('async editLastTurn(newText: string): Promise<void> {');
    expect(method).toBeGreaterThan(-1);
    const body = src.slice(method, src.indexOf('async switchTurnVariant', method));
    expect(body).toContain('if (this.streaming) return;');
    expect(body).toContain('this.adoptTurnVariantLedger(');
    expect(body).toContain('this.messages = this.messages.slice(0, start);');
    // 截断即刻落盘：崩溃恢复不再出现已被上下文淘汰的旧回合。
    expect(body).toContain('await this.persistSession(this.messages, new Map(), []);');
    // 原句气泡连同自身一起让位：屏上只留编辑后的新句，不再连续两句。
    expect(body).toContain('this.pruneThroughLastUserBubble()');
    expect(body).not.toContain('this.pruneTranscriptAfterLastUserBubble()');
    // 不带 skipUserPersist:user_input 照记,与重新生成的本质区别。
    expect(body).toContain('await this.send(newText, userMessage.images ?? [], newText, false, userMessage.attachments ?? []);');
    expect(body).not.toContain('skipUserPersist');
  });

  it('pruneThroughLastUserBubble removes the original question row itself — the edited sentence replaces it on screen', () => {
    const method = src.indexOf('private pruneThroughLastUserBubble(): void {');
    expect(method).toBeGreaterThan(-1);
    const body = src.slice(method, src.indexOf('async send(', method));
    expect(body).toContain("querySelectorAll<HTMLElement>('.bubble-row.user')");
    expect(body).toContain('node.remove()');
    // 与重新生成的清理区分开：那条保留原气泡，从它之后的兄弟开始删。
    const keep = src.indexOf('private pruneTranscriptAfterLastUserBubble(): void {');
    expect(keep).toBeGreaterThan(-1);
    expect(src.slice(keep, keep + 700)).toContain('lastUserRow.nextElementSibling');
  });

  it('the ledger identity follows the ACTIVE variant, so an edited question re-anchors the same group', () => {
    expect(src).toContain('groupAnchoredToTurn(this.turnVariants, this.messages)');
    const adopt = src.indexOf('private adoptTurnVariantLedger(slice: Message[]): void {');
    expect(adopt).toBeGreaterThan(-1);
    const adoptBody = src.slice(adopt, adopt + 700);
    expect(adoptBody).toContain('groupAnchoredToTurn(this.turnVariants, this.messages)');
    expect(adoptBody).toContain('variants: [{ messages: slice, fingerprint }], active: 0');
  });

  it('the composer gets the visible last-question text for the edit backfill', () => {
    const method = src.indexOf('getLastUserTurnText(): string | null {');
    expect(method).toBeGreaterThan(-1);
    const body = src.slice(method, method + 260);
    expect(body).toContain('stripUserTurnContext(this.messages[start].content)');
  });

  it('the ledger syncs on every persist and notifies the host when a variant is added', () => {
    const persist = src.indexOf('private async doPersistSession(');
    expect(persist).toBeGreaterThan(-1);
    // 13 个参数 + 注释的签名很长,锚函数体第一行而不是方法头。
    const bodyStart = src.indexOf('if (messages.length <= 0) return;', persist);
    expect(bodyStart).toBeGreaterThan(-1);
    const head = src.slice(bodyStart, bodyStart + 520);
    expect(head).toContain('this.syncTurnVariantsWithMessages(messages)');
    expect(head).toContain("this.onTurnVariantsChanged?.('regenerated')");
    // sync 本体:追加式入册(不覆盖 active 槽——覆盖会丢刚入册的旧版)
    const sync = src.indexOf('private syncTurnVariantsWithMessages(');
    expect(sync).toBeGreaterThan(-1);
    const syncBody = src.slice(sync, sync + 900);
    expect(syncBody).toContain('group.variants.push(');
    expect(syncBody).toContain('TURN_VARIANT_CAP');
  });

  it('switching replaces the message tail with the chosen variant and persists before replay', () => {
    const method = src.indexOf('async switchTurnVariant(index: number): Promise<void> {');
    expect(method).toBeGreaterThan(-1);
    const body = src.slice(method, src.indexOf('private syncTurnVariantsWithMessages', method));
    expect(body).toContain('if (this.streaming) return;');
    expect(body).toContain('groupAnchoredToTurn(group, this.messages)');
    expect(body.indexOf('this.persistSession(this.messages, new Map(), [])')).toBeGreaterThan(-1);
    expect(body.indexOf("this.onTurnVariantsChanged?.('switched')")).toBeGreaterThan(body.indexOf('this.persistSession'));
  });

  it('the variant ledger rides the snapshot uiState and comes back through normalize', () => {
    expect(src).toContain('turnVariants: this.turnVariants ?? undefined');
    expect(src).toContain('this.turnVariants = normalizeTurnVariants(snapshot.uiState.turnVariants);');
  });

  it('the session manager forwards variant APIs for the visible conversation only', () => {
    expect(src).toContain('getTurnVariantInfo(): { count: number; active: number } | null {\n    return this.current?.getTurnVariantInfo() ?? null;');
    const wire = src.indexOf('controller.onTurnVariantsChanged = (reason) => {');
    expect(wire).toBeGreaterThan(-1);
    expect(src.slice(wire, wire + 160)).toContain('if (controller === this.current) this.turnVariantsCb?.(reason)');
  });

  it('the prune keeps the user bubble and removes only its following siblings', () => {
    const method = src.indexOf('private pruneTranscriptAfterLastUserBubble(): void {');
    expect(method).toBeGreaterThan(-1);
    const body = src.slice(method, method + 700);
    expect(body).toContain(".bubble-row.user");
    expect(body).toContain('nextElementSibling');
  });
});
