// src/channels/verifierProfile.ts
// 通道档验证器（设计文档 §5.2）。CLI 为了延迟用纯规则验证器；通道场景**没有人
// 在旁边看输出**，验证是唯一的质量闸，所以走「规则 + LLM 复核」这一档，并且是
// 同步复核 —— 判定失败会在引擎内触发重写，而不是把没人复核过的答案直接发出去。
// 这是与 CLI 默认值的**有意分叉**，必须显式传参（不能靠默认值继承）。
import { createLLMVerifier, LLMVerifyCheckName, type LLMVerifierOptions, type Verifier } from '../coding-agent/Verifier';
import type { LLMAdapter } from '../shared/types';

export { LLMVerifyCheckName };

export function createChannelVerifier(llm: LLMAdapter, options?: LLMVerifierOptions): Verifier {
  return createLLMVerifier(llm, options);
}
