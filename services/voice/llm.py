"""Nemotron 3.5 Lightning through NVIDIA's OpenAI-compatible endpoint, thinking off.

Lightning reasons by default (it burned all 300 tokens on reasoning in the S3 spike and never answered). The switch is the chat
template flag `chat_template_kwargs: {enable_thinking: false}`, sent in extra_body."""
from __future__ import annotations

from pipecat.services.nvidia.llm import NvidiaLLMService

from config import Settings


class LightningLLMService(NvidiaLLMService):
    def build_chat_completion_params(self, params_from_context):
        params = super().build_chat_completion_params(params_from_context)
        self._merge_extra_body(params, {"chat_template_kwargs": {"enable_thinking": False}})
        return params


def build_llm(s: Settings) -> LightningLLMService:
    return LightningLLMService(
        api_key=s.llm_api_key,
        base_url=s.llm_base_url,
        # the hosted free tier occasionally parks a request for many seconds (seen: a 16 s first token): re-issue it once after retry_secs
        retry_on_timeout=True,
        retry_timeout_secs=s.llm_retry_secs,
        settings=LightningLLMService.Settings(model=s.llm_model, temperature=s.llm_temperature, top_p=s.llm_top_p, max_completion_tokens=s.llm_max_tokens),
    )
