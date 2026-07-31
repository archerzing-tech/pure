// src/coding-agent/Planner.ts
// v0.1 — Analyzes tasks: determines complexity, optionally generates a plan.

import type { AnalysisResult, TaskComplexity, Plan, PlanStep } from './types';

export interface PlannerConfig {
  /** Threshold for 'complex': > this many file ops triggers planning. */
  complexFileThreshold?: number;
  /** Always plan when the user asks for it. */
}

export class Planner {
  private config: Required<PlannerConfig>;

  constructor(config?: PlannerConfig) {
    this.config = {
      complexFileThreshold: config?.complexFileThreshold ?? 3,
    };
  }

  /** Analyze a task prompt to determine complexity and optionally generate a plan. */
  analyzeTask(prompt: string): AnalysisResult {
    const complexity = this.detectComplexity(prompt);

    if (complexity === 'complex') {
      return {
        complexity,
        plan: this.generatePlan(prompt),
        reasoning: this.getComplexReasoning(prompt),
      };
    }

    return {
      complexity: 'simple',
      reasoning: 'Task appears straightforward — direct execution is appropriate.',
    };
  }

  private detectComplexity(prompt: string): TaskComplexity {
    const lower = prompt.toLowerCase();

    // User explicitly asks for planning
    if (/plan|先计划|规划|设计|think step by step|think through/i.test(prompt)) {
      return 'complex';
    }

    // Multiple file operations or new module creation
    const fileOpPatterns = [
      /create\s+(a\s+)?(new\s+)?(file|module|class|component|service|api)/i,
      /refactor|重构|重写|rewrite/i,
      /migrate|迁移/i,
      /add\s+(a\s+)?(new\s+)?feature/i,
      /implement\s+(a\s+)?(full|complete|end.to.end)/i,
    ];

    const matches = fileOpPatterns.filter(p => p.test(lower));
    if (matches.length >= this.config.complexFileThreshold) {
      return 'complex';
    }

    // Scope indicators
    const scopeIndicators = [
      /multiple\s+files/i,
      /several\s+(files|modules|components)/i,
      /whole\s+(project|app|system)/i,
      /from\s+scratch/i,
    ];

    if (scopeIndicators.some(p => p.test(lower))) {
      return 'complex';
    }

    return 'simple';
  }

  private generatePlan(prompt: string): Plan {
    // Generate a generic plan based on task analysis
    const steps: PlanStep[] = [
      {
        id: '1',
        action: 'Understand',
        description: 'Read relevant files and understand the current codebase structure.',
        expectedOutcome: 'Clear understanding of what needs to change.',
      },
      {
        id: '2',
        action: 'Plan',
        description: 'Design the solution approach and identify files to modify.',
        expectedOutcome: 'Concrete change plan with file-by-file details.',
      },
      {
        id: '3',
        action: 'Implement',
        description: 'Execute changes across identified files.',
        expectedOutcome: 'Working implementation matching the plan.',
      },
      {
        id: '4',
        action: 'Verify',
        description: 'Run tests and verify the implementation works correctly.',
        expectedOutcome: 'All tests pass, changes are validated.',
      },
    ];

    return {
      steps,
      reasoning: this.getComplexReasoning(prompt),
    };
  }

  private getComplexReasoning(prompt: string): string {
    return `This task involves multiple files or significant changes. A structured approach with planning, implementation, and verification steps will ensure correctness.`;
  }
}
