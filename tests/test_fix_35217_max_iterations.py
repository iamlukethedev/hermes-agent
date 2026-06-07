"""Test fix for issue #35217: CLI crashes when max_iterations is set to -1."""

import pytest
from unittest import mock
from run_agent import AIAgent


def test_max_iterations_negative_value_is_reset_to_default():
    """Test that negative max_iterations values are reset to default (90)."""
    with mock.patch('agent.model_metadata.get_model_context_length', return_value=200000):
        agent = AIAgent(
            base_url="https://api.openai.com/v1",
            api_key="test-key",
            provider="openai",
            model="gpt-4-turbo",
            max_iterations=-1,  # Invalid negative value
        )
        assert agent.max_iterations == 90, "Negative max_iterations should be reset to 90"


def test_max_iterations_zero_is_accepted():
    """Test that zero max_iterations is accepted (edge case for limiting iterations)."""
    with mock.patch('agent.model_metadata.get_model_context_length', return_value=200000):
        agent = AIAgent(
            base_url="https://api.openai.com/v1",
            api_key="test-key",
            provider="openai",
            model="gpt-4-turbo",
            max_iterations=0,
        )
        assert agent.max_iterations == 0, "Zero max_iterations should be allowed"


def test_max_iterations_positive_value_is_preserved():
    """Test that positive max_iterations values are preserved."""
    with mock.patch('agent.model_metadata.get_model_context_length', return_value=200000):
        agent = AIAgent(
            base_url="https://api.openai.com/v1",
            api_key="test-key",
            provider="openai",
            model="gpt-4-turbo",
            max_iterations=50,
        )
        assert agent.max_iterations == 50, "Positive max_iterations should be preserved"


def test_max_iterations_default_value():
    """Test that default max_iterations is 90 when not specified."""
    with mock.patch('agent.model_metadata.get_model_context_length', return_value=200000):
        agent = AIAgent(
            base_url="https://api.openai.com/v1",
            api_key="test-key",
            provider="openai",
            model="gpt-4-turbo",
        )
        assert agent.max_iterations == 90, "Default max_iterations should be 90"


def test_iteration_budget_created_with_valid_max_iterations():
    """Test that iteration_budget is correctly created with valid max_iterations."""
    with mock.patch('agent.model_metadata.get_model_context_length', return_value=200000):
        agent = AIAgent(
            base_url="https://api.openai.com/v1",
            api_key="test-key",
            provider="openai",
            model="gpt-4-turbo",
            max_iterations=-1,  # This should be reset to 90
        )
        assert agent.iteration_budget is not None
        assert agent.iteration_budget.max_total == 90
