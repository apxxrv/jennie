"""The one place a Claude client is built: the Anthropic API by default, AWS Bedrock under CLAUDE_PROVIDER=bedrock."""

from typing import Any

from app.config import get_settings


def claude_client(**kwargs: Any) -> Any:
    """An anthropic.Anthropic or anthropic.AnthropicBedrock client. kwargs (timeout, max_retries) pass through to either."""
    import anthropic

    s = get_settings()
    if s.claude_provider == "bedrock":
        return anthropic.AnthropicBedrock(aws_region=s.aws_region, aws_profile=s.aws_profile or None, **kwargs)
    key = s.anthropic_api_key
    return anthropic.Anthropic(api_key=key, **kwargs) if key else anthropic.Anthropic(**kwargs)
