/**
 * Simple Usage Example
 * 
 * This shows how to use X-Ray with your own data.
 * The SDK is general-purpose and works with any pipeline.
 */

import { xray, StepType, CaptureLevel, Environment } from '../src/index';

// Configure X-Ray
xray.configure({
  apiUrl: 'http://localhost:4000',
  defaultCaptureLevel: CaptureLevel.SUMMARY,
  degradeOnError: true
});

// Your actual data types
interface Item {
  id: string;
  name: string;
  score: number;
}

// Your actual pipeline functions
async function fetchItems(): Promise<Item[]> {
  // Replace with your actual data fetching logic
  return [
    { id: '1', name: 'Item A', score: 0.9 },
    { id: '2', name: 'Item B', score: 0.7 },
    { id: '3', name: 'Item C', score: 0.3 },
    { id: '4', name: 'Item D', score: 0.8 },
  ];
}

async function filterItems(items: Item[], threshold: number): Promise<Item[]> {
  return items.filter(item => item.score >= threshold);
}

async function rankItems(items: Item[]): Promise<Item[]> {
  return [...items].sort((a, b) => b.score - a.score);
}

// Instrumented pipeline
async function myPipeline(): Promise<Item | null> {
  return await xray.run('my-custom-pipeline', 'v1.0.0', async () => {
    
    // Step 1: Fetch data
    const items = await xray.step(StepType.INPUT, 'fetch-items', async () => {
      return await fetchItems();
    });

    // Step 2: Filter
    const filtered = await xray.step(StepType.FILTER, 'score-filter', async () => {
      return await filterItems(items, 0.5);
    }, {
      captureLevel: CaptureLevel.SUMMARY,
      artifacts: { threshold: 0.5, rule: 'score >= 0.5' },
      metrics: { 
        input_count: items.length,
        output_count: items.filter(i => i.score >= 0.5).length
      }
    });

    // Step 3: Rank
    const ranked = await xray.step(StepType.RANKING, 'score-ranking', async () => {
      return await rankItems(filtered);
    }, {
      captureLevel: CaptureLevel.FULL,
      candidates: filtered.map(item => ({
        candidateId: item.id,
        content: item,
        metadata: { score: item.score }
      })),
      artifacts: { method: 'descending_score' }
    });

    // Step 4: Select best
    const selected = await xray.step(StepType.SELECTION, 'select-best', async () => {
      return ranked[0] || null;
    }, {
      artifacts: { 
        selected_id: ranked[0]?.id,
        selected_score: ranked[0]?.score
      }
    });

    return selected;

  }, { environment: Environment.DEV });
}

// Run it
async function main(): Promise<void> {
  console.log('Running custom pipeline with X-Ray instrumentation...\n');
  
  try {
    const result = await myPipeline();
    console.log('Result:', result);
    console.log('\nX-Ray data captured! Query with:');
    console.log('  curl http://localhost:4000/api/v1/runs');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
