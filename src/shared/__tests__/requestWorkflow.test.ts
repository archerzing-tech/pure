import { describe, expect, it } from 'bun:test';
import { compileRequestWorkflow } from '../requestWorkflow';


describe('compileRequestWorkflow', () => {
  it('keeps a direct question lightweight', () => {
    const workflow = compileRequestWorkflow('What does this file do?', { hasTools: true });

    expect(workflow.stage).toBe('direct');
    expect(workflow.needsProbe).toBe(false);
    expect(workflow.needsDeliveryGate).toBe(false);
    expect(workflow.userContext.buildProtocol).toBeUndefined();
    expect(workflow.userContext.assessment).toBeUndefined();
  });

  it('compiles the same probe and build context for GUI and CLI callers', () => {
    const prompt = 'Build a complete project for a team dashboard';
    const gui = compileRequestWorkflow(prompt, { hasTools: true });
    const cli = compileRequestWorkflow(prompt, { hasTools: true });

    expect(gui).toEqual(cli);
    expect(gui.stage).toBe('plan');
    expect(gui.probeRequired).toBe(true);
    expect(gui.probeAvailable).toBe(true);
    expect(gui.needsProbe).toBe(true);
    expect(gui.needsDeliveryGate).toBe(true);
    expect(gui.userContext.buildProtocol).toContain('Incremental build protocol');
  });

  it('raises a high-risk request to confirmation even when the task is otherwise simple', () => {
    const workflow = compileRequestWorkflow('Delete the entire build directory', { hasTools: true });

    expect(workflow.stage).toBe('confirm');
    expect(workflow.analysis.intent.requiresConfirmation).toBe(true);
    expect(workflow.probeRequired).toBe(true);
    expect(workflow.probeAvailable).toBe(true);
    expect(workflow.needsProbe).toBe(true);
    expect(workflow.userContext.traps).toBeUndefined();
  });

  it('respects an explicit mode without changing the original prompt semantics', () => {
    const workflow = compileRequestWorkflow('Explain the current architecture', {
      forcedMode: 'plan',
      hasTools: false,
    });

    expect(workflow.analysis.mode).toBe('plan');
    expect(workflow.requiresPlanReview).toBe(true);
    expect(workflow.needsProbe).toBe(false);
    expect(workflow.userContext.buildProtocol).toBeUndefined();
  });

  it('does not require a workspace probe when tools are unavailable', () => {
    const workflow = compileRequestWorkflow('Refactor the authentication module', { hasTools: false });

    expect(workflow.stage).toBe('direct');
    expect(workflow.probeRequired).toBe(true);
    expect(workflow.probeAvailable).toBe(false);
    expect(workflow.needsProbe).toBe(false);
    expect(workflow.analysis.intent.requiresProbe).toBe(true);
  });
});
