"""
RLM Marketplace REPL Tools

Imported by the root agent in the Python REPL environment.
Provides sub_agent(), market operations, evidence management,
and the GEPA hill-climbing loop.

Usage in REPL:
    from marketplace_tools import *

    # Load idea corpus
    ideas = load_ideas(query="climate")

    # Decompose and evaluate
    for claim in ideas[0]["claims"]:
        verdict = sub_agent(f"Evaluate: {claim}")
        market.buy(claim["id"], verdict["confidence"])

    # Observe price as signal
    price = market.price(claim["id"])

    # Distill winning trajectories
    distillate = distill.round(1)

    # GEPA: propose mutations
    for idea in top_ideas():
        variant = mutate(idea)
        propose(variant)
"""

from dataclasses import dataclass, field
from typing import Optional
import json
import os
import subprocess
import sys


MCP_REGISTRY_URL = os.environ.get("MCP_REGISTRY_URL", "http://localhost:9000")


def _call_mcp(tool: str, args: dict) -> dict:
    """Call the idea-registry MCP server via HTTP."""
    import urllib.request
    payload = json.dumps({
        "method": "tools/call",
        "params": {"name": tool, "arguments": args}
    }).encode()
    req = urllib.request.Request(
        f"{MCP_REGISTRY_URL}/mcp",
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read())
    if body.get("error"):
        raise RuntimeError(f"MCP error: {body['error']}")
    content = body.get("result", {}).get("content", [{}])[0].get("text", "{}")
    return json.loads(content)


class SubAgent:
    """Programmatic sub-agent calls. The key RLM primitive.

    Calls the idea-registry MCP server's evaluate_claim tool,
    which dispatches to real LLMs (DeepSeek, Anthropic, etc.).
    """

    def __call__(self, prompt: str) -> dict:
        """Spawn a sub-agent to evaluate a prompt. Returns structured Verdict.

        The sub-agent never sees the full idea corpus — only the prompt given.
        This prevents context rot and groupthink.
        """
        return {
            "confidence": 0.0,
            "reasoning": f"[Use evaluate_claim(claim_id) for real LLM evaluation. Prompt: {prompt[:100]}...]",
            "evidence_reviewed": [],
            "agent_id": "sub",
            "timestamp": 0,
        }

    def evaluate_claim(self, claim_id: str, providers: list[str] | None = None) -> dict:
        """Evaluate a claim using real LLMs via the MCP server.
        
        This is the ACTUAL evaluation — not a stub. Calls DeepSeek (default)
        or multiple providers for cross-model comparison.
        """
        providers = providers or ["deepseek"]
        return _call_mcp("evaluate_claim", {
            "claim_id": claim_id,
            "providers": providers,
        })

    def evaluate_all_claims(self, idea_id: str, providers: list[str] | None = None) -> list[dict]:
        """Evaluate all claims for an idea using real LLMs, returning verdicts for each."""
        idea = _call_mcp("search_ideas", {"query": idea_id})
        results = []
        for i, _claim_text in enumerate(idea[0].get("claims", []) if idea else []):
            claim_id = f"{idea[0]['id']}-claim-{i + 1}"
            result = self.evaluate_claim(claim_id, providers)
            results.append(result)
        return results


class Market:
    """Prediction market operations. Prices aggregate information via LMSR."""

    def buy_yes(self, claim_id: str, agent_id: str, amount: float) -> float:
        """Buy YES shares. Returns new yes_price."""
        result = _call_mcp("place_market_order", {
            "claim_id": claim_id,
            "agent_id": agent_id,
            "side": "yes",
            "amount": amount,
        })
        return result["new_yes_price"]

    def buy_no(self, claim_id: str, agent_id: str, amount: float) -> float:
        """Buy NO shares. Returns new no_price."""
        result = _call_mcp("place_market_order", {
            "claim_id": claim_id,
            "agent_id": agent_id,
            "side": "no",
            "amount": amount,
        })
        return result["new_no_price"]

    def price(self, claim_id: str) -> float:
        """Get current YES price. The primary signal."""
        result = _call_mcp("get_market", {"claim_id": claim_id})
        return result["yes_price"]

    def state(self, claim_id: str) -> dict:
        """Get full market state: prices, shares, verdict count, resolution."""
        return _call_mcp("get_market", {"claim_id": claim_id})

    def settle(self, claim_id: str, outcome: bool) -> dict:
        """Resolve a claim. Pay winners. Update reputations."""
        return _call_mcp("settle_market", {
            "claim_id": claim_id,
            "outcome": outcome,
        })

    def settle_all_above(self, threshold: float) -> list[dict]:
        """Settle all claims with price above threshold as TRUE."""
        state = _call_mcp("get_state", {})
        results = []
        for cid, m in state.get("markets", {}).items():
            if m.get("resolution"):
                continue
            if m["yes_price"] >= threshold:
                results.append(self.settle(cid, True))
            elif m["yes_price"] <= (1 - threshold):
                results.append(self.settle(cid, False))
        return results


class EvidenceOps:
    """Evidence management for claims."""

    def search(self, claim_id: str, query: str = "") -> list[dict]:
        """Search evidence for a claim."""
        state = _call_mcp("get_state", {})
        return state.get("evidence", {}).get(claim_id, [])

    def submit(self, claim_id: str, url: str, excerpt: str, relevance: float, agent_id: str) -> str:
        """Submit new evidence for a claim."""
        result = _call_mcp("submit_evidence", {
            "claim_id": claim_id,
            "source_url": url,
            "excerpt": excerpt,
            "relevance": relevance,
            "submitted_by": agent_id,
        })
        return result["evidence_id"]


class Distiller:
    """Distillation operations. Extract winning trajectories and propose prompt mutations."""

    def round(self, round_num: int) -> dict:
        """Extract winning trajectories from a completed round."""
        return _call_mcp("distill_trajectories", {})

    def find_divergence(self, min_verdicts: int = 2, limit: int = 10) -> dict:
        """Find claims with highest evaluation variance.
        
        Fisher's theorem: variance in fitness = rate of evolution.
        High-divergence claims are where the market learns fastest.
        """
        return _call_mcp("find_divergence", {
            "min_verdicts": min_verdicts,
            "limit": limit,
        })

    def mutate_prompt(self, target: str, pattern: str, improvement: str) -> dict:
        """Propose a prompt mutation based on distilled learning."""
        return {"target": target, "pattern": pattern, "improvement": improvement}


class IdeaRegistry:
    """Idea corpus operations."""

    def propose(self, title: str, summary: str, body: str, claims: list[str],
                evidence_links: list[str], author: str, parent_id: Optional[str] = None) -> str:
        """Propose a new idea."""
        result = _call_mcp("propose_idea", {
            "title": title,
            "summary": summary,
            "body": body,
            "claims": claims,
            "evidence_links": evidence_links,
            "author": author,
            "parent_id": parent_id,
        })
        return result["idea_id"]

    def fork(self, parent_id: str, title: str, summary: str, body: str,
             claims: list[str], evidence_links: list[str], author: str,
             mutation_description: str) -> str:
        """Fork an existing idea with a variant."""
        result = _call_mcp("fork_idea", {
            "parent_id": parent_id,
            "title": title,
            "summary": summary,
            "body": body,
            "claims": claims,
            "evidence_links": evidence_links,
            "author": author,
            "mutation_description": mutation_description,
        })
        return result["idea_id"]

    def search(self, query: str) -> list[dict]:
        """Search the idea corpus."""
        return _call_mcp("search_ideas", {"query": query})

    def tree(self, idea_id: str) -> dict:
        """Get the full idea tree (ancestors + descendants)."""
        return _call_mcp("get_idea_tree", {"idea_id": idea_id})

    def top(self, limit: int = 10) -> list[dict]:
        """Get top ideas by rent score."""
        state = _call_mcp("get_state", {})
        return state.get("top_ideas", [])[:limit]


def compute_rent(idea_id: str) -> dict:
    """Compute rent score for an idea."""
    return _call_mcp("compute_rent", {"idea_id": idea_id})


def verify(claim_id: str, method: str, evidence_hash: str,
           reproducibility: float, verified_by: str) -> dict:
    """Verify a claim."""
    return _call_mcp("verify_claim", {
        "claim_id": claim_id,
        "method": method,
        "evidence_hash": evidence_hash,
        "reproducibility": reproducibility,
        "verified_by": verified_by,
    })


def gepa_loop(root_agent_id: str, topic: str, rounds: int = 3, providers: list[str] | None = None) -> dict:
    """Run the full GEPA meta-loop with REAL LLM evaluation.

    Each round:
    1. Generate: real sub-agent LLM calls evaluate claims → market orders placed
    2. Evaluate: price discovery → find high-variance claims (Fisher gradient)
    3. Propose: fork successful ideas + fork high-divergence claims for deeper study
    4. Adapt: distill winning trajectories → propose prompt mutations

    High-divergence claims (where sub-agents disagree) are prioritized —
    they're where the market has the most information to discover.
    """
    sub = SubAgent()
    market = Market()
    registry = IdeaRegistry()

    for round_num in range(1, rounds + 1):
        # GENERATE: search and evaluate claims using REAL LLMs
        ideas = registry.search(topic)

        for idea in ideas:
            for i, _claim_text in enumerate(idea.get("claims", [])):
                claim_id = f"{idea['id']}-claim-{i + 1}"
                
                # REAL LLM evaluation — calls evaluate_claim MCP tool
                result = sub.evaluate_claim(claim_id, providers)
                
                if "error" in result:
                    continue

                aggregate = result.get("aggregate", {})
                confidence = aggregate.get("confidence", 0.5)

                # Place market order based on real LLM verdict
                weight = confidence * 0.1 * 1000  # fixed budget
                if confidence > 0.6:
                    market.buy_yes(claim_id, root_agent_id, weight)
                elif confidence < 0.4:
                    market.buy_no(claim_id, root_agent_id, weight)

        # EVALUATE: settle high-confidence claims
        resolved = market.settle_all_above(0.85)

        # FIND DIVERGENCE: Fisher's theorem — high variance = high evolution rate
        divergence = _call_mcp("find_divergence", {"min_verdicts": 2, "limit": 5})
        high_div = divergence.get("top_divergent", [])

        # PROPOSE: fork successful ideas AND high-divergence claims
        top = registry.top(5)
        for idea in top:
            registry.fork(
                parent_id=idea["id"],
                title=f"{idea['id']}-v{round_num}",
                summary=f"Refinement of {idea['title']} from round {round_num}",
                body=f"Evolved from round {round_num}. Based on market-confirmed claims.",
                claims=[f"Refined: {idea['title']}"],
                evidence_links=[],
                author=f"gepa-r{round_num}",
                mutation_description=f"Auto-refined from round {round_num}",
            )

        # Also fork high-divergence claims for deeper investigation
        for claim in high_div[:3]:
            idea_id = claim["claimId"].rsplit("-claim-", 1)[0]
            registry.fork(
                parent_id=idea_id,
                title=f"{idea_id}-deep-{round_num}",
                summary=f"Deep investigation of high-divergence claim (variance={claim['variance']})",
                body=f"Fisher gradient exploration. Variance: {claim['variance']}. Sub-agents disagreed — this is where learning happens.",
                claims=[f"Re-examined: {claim.get('claimText', '')}"],
                evidence_links=[],
                author=f"fisher-r{round_num}",
                mutation_description=f"Deep dive on divergence={claim['divergence']}",
            )

        # ADAPT: distill trajectories
        distillate = _call_mcp("distill_trajectories", {})

    return _call_mcp("get_state", {})


@dataclass
class DeliberationState:
    """The full deliberation state as a REPL variable.

    The root agent operates on this state symbolically.
    It never needs to hold full deliberation text in its context window.
    """
    ideas: list[dict] = field(default_factory=list)
    markets: dict = field(default_factory=dict)
    verdicts: dict = field(default_factory=dict)
    round: int = 1
    top_claims: list[dict] = field(default_factory=list)
    distillate: Optional[dict] = None


def load_state(topic: str = "") -> DeliberationState:
    """Load the current deliberation state into a REPL variable."""
    full_state = _call_mcp("get_state", {})
    registry = IdeaRegistry()
    ideas = registry.search(topic) if topic else []
    return DeliberationState(
        ideas=ideas,
        markets=full_state.get("markets", {}),
        round=full_state.get("round", 1),
    )


sub_agent = SubAgent()
market = Market()
evidence = EvidenceOps()
distill = Distiller()
idea_registry = IdeaRegistry()
