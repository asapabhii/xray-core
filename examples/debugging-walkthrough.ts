/**
 * Debugging Walkthrough Example
 * 
 * Scenario: Phone case incorrectly matched against laptop stand
 * 
 * This example demonstrates how X-Ray helps debug a multi-step
 * product matching pipeline that produces incorrect results.
 */

import { xray, StepType, CaptureLevel } from '../src/index';

interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  keywords: string[];
}

async function productMatchingPipeline(query: string): Promise<Product[]> {
  return await xray.run(
    'product-matcher',
    'v1.2.0',
    async () => {
      // Step 1: INPUT - Fetch candidate products
      const candidates = await xray.step(
        StepType.INPUT,
        'fetch-candidates',
        async () => {
          // Simulate fetching 5000 products
          return Array.from({ length: 5000 }, (_, i) => ({
            id: `prod-${i}`,
            name: `Product ${i}`,
            category: i % 10 === 0 ? 'electronics' : 'accessories',
            price: Math.random() * 200,
            keywords: []
          }));
        }
      );

      // Step 2: GENERATION - Extract keywords using LLM
      const withKeywords = await xray.step(
        StepType.GENERATION,
        'keyword-extraction',
        async () => {
          // Simulate LLM keyword extraction
          // BUG: This incorrectly extracts keywords
          return candidates.map(c => ({
            ...c,
            keywords: c.name.toLowerCase().split(' ').slice(0, 2)
          }));
        },
        {
          captureLevel: CaptureLevel.SUMMARY,
          artifacts: {
            model: 'gpt-4',
            reasoning_summary: 'Extracted keywords from product titles',
            tokens_used: 1200
          }
        }
      );

      // Step 3: FILTER - Category matching
      const categoryFiltered = await xray.step(
        StepType.FILTER,
        'category-match',
        async () => {
          const queryCategory = query.includes('phone') ? 'electronics' : 'accessories';
          return withKeywords.filter(p => p.category === queryCategory);
        },
        {
          captureLevel: CaptureLevel.SUMMARY,
          artifacts: {
            rule: 'category must match query category',
            query_category: query.includes('phone') ? 'electronics' : 'accessories'
          },
          metrics: {
            rejected_count: 5000 - (query.includes('phone') ? 500 : 4500)
          }
        }
      );

      // Step 4: RANKING - Relevance scoring
      const ranked = await xray.step(
        StepType.RANKING,
        'relevance-score',
        async () => {
          const queryKeywords = query.toLowerCase().split(' ');
          return categoryFiltered
            .map(p => ({
              ...p,
              score: calculateRelevanceScore(p, queryKeywords)
            }))
            .sort((a, b) => b.score - a.score);
        },
        {
          captureLevel: CaptureLevel.FULL,
          candidates: categoryFiltered.slice(0, 100).map(p => ({
            candidateId: p.id,
            content: p,
            metadata: { score: calculateRelevanceScore(p, query.toLowerCase().split(' ')) }
          })),
          artifacts: {
            method: 'cosine_similarity',
            top_score: 0.95,
            score_distribution: 'normal'
          }
        }
      );

      // Step 5: SELECTION - Top 10
      const selected = await xray.step(
        StepType.SELECTION,
        'top-10',
        async () => {
          return ranked.slice(0, 10);
        },
        {
          captureLevel: CaptureLevel.SUMMARY,
          artifacts: {
            selection_count: 10,
            selection_method: 'top_n'
          }
        }
      );

      return selected;
    }
  );
}

function calculateRelevanceScore(product: Product, queryKeywords: string[]): number {
  // BUG: This only matches on keyword overlap, not semantic similarity
  const overlap = product.keywords.filter(k => queryKeywords.includes(k)).length;
  return overlap / Math.max(queryKeywords.length, product.keywords.length);
}

/**
 * Debugging Process:
 * 
 * 1. Query X-Ray for the problematic run:
 *    GET /api/v1/runs?pipeline_name=product-matcher&started_after=2024-01-15T10:00:00Z
 * 
 * 2. Inspect each step:
 *    GET /api/v1/steps?run_id=<run_id>
 * 
 * 3. Identify issues:
 *    - Step 2 (GENERATION): Keywords extracted incorrectly
 *      - Artifact shows: "phone case" → ["phone", "case"]
 *      - Should have identified product type, but didn't
 * 
 *    - Step 3 (FILTER): Over-aggressive category filter
 *      - Dropped 4500 candidates
 *      - Phone case should have matched "electronics" but didn't
 * 
 *    - Step 4 (RANKING): Score was high (0.95) but irrelevant
 *      - Cosine similarity matched on "phone" keyword
 *      - Laptop stand scored high because it contains "stand" (not in query)
 * 
 * 4. Root cause:
 *    - Keyword extraction (GENERATION) failed to identify product type
 *    - Category filter (FILTER) was too strict
 *    - Ranking (RANKING) optimized for keyword match, not semantic similarity
 * 
 * 5. Fix:
 *    - Update GENERATION step to include product type detection
 *    - Relax FILTER rules to allow cross-category matches
 *    - Adjust RANKING weights to prioritize semantic similarity
 */

// Example usage
async function main() {
  try {
    const results = await productMatchingPipeline('phone case');
    console.log('Results:', results);
  } catch (error) {
    console.error('Pipeline failed:', error);
  }
}

if (require.main === module) {
  main();
}

