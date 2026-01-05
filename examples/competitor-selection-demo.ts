/**
 * Competitor Selection Demo
 * 
 * This demonstrates a realistic competitor selection pipeline that:
 * 1. Generates search keywords from a product (LLM step)
 * 2. Retrieves candidate competitors
 * 3. Filters by price/category
 * 4. Ranks by relevance
 * 5. Selects the best match
 * 
 * The demo intentionally includes a bug that causes a phone case
 * to match against a laptop stand - demonstrating how X-Ray helps debug this.
 */

import { xray, StepType, CaptureLevel, Environment } from '../src/index';

// Configure X-Ray to use local backend
xray.configure({
  apiUrl: 'http://localhost:4000',
  defaultCaptureLevel: CaptureLevel.SUMMARY,
  enableAsyncIngestion: false, // Sync for demo clarity
  degradeOnError: false // Fail loudly for demo
});

// ============ TYPES ============

interface Product {
  id: string;
  title: string;
  category: string;
  price: number;
  rating: number;
  reviewCount: number;
  attributes: string[];
}

interface ScoredProduct extends Product {
  relevanceScore: number;
  matchReasons: string[];
}

interface FilterResult {
  passed: Product[];
  rejected: Array<{ product: Product; reason: string }>;
}

// ============ MOCK DATA ============

const PRODUCT_CATALOG: Product[] = [
  // Phone accessories - lower review counts
  { id: 'P001', title: 'Premium Silicone Phone Case for iPhone 15', category: 'phone-accessories', price: 19.99, rating: 4.5, reviewCount: 250, attributes: ['silicone', 'protective', 'slim', 'iphone'] },
  { id: 'P002', title: 'Clear Phone Case with MagSafe', category: 'phone-accessories', price: 29.99, rating: 4.7, reviewCount: 190, attributes: ['clear', 'magsafe', 'protective', 'iphone'] },
  { id: 'P003', title: 'Leather Wallet Phone Case', category: 'phone-accessories', price: 39.99, rating: 4.3, reviewCount: 167, attributes: ['leather', 'wallet', 'premium', 'cards'] },
  
  // Laptop accessories - THE BUG: These have high review counts and "phone" keyword
  { id: 'L001', title: 'Adjustable Laptop Stand - Aluminum', category: 'laptop-accessories', price: 45.99, rating: 4.8, reviewCount: 2100, attributes: ['aluminum', 'adjustable', 'ergonomic', 'stand'] },
  { id: 'L002', title: 'Portable Phone & Tablet Stand', category: 'laptop-accessories', price: 24.99, rating: 4.6, reviewCount: 1780, attributes: ['portable', 'phone', 'tablet', 'stand', 'slim'] }, // Has "phone" + "slim" + high reviews!
  { id: 'L003', title: 'Laptop Cooling Pad with Phone Holder', category: 'laptop-accessories', price: 35.99, rating: 4.5, reviewCount: 1445, attributes: ['cooling', 'phone', 'holder', 'laptop', 'slim'] }, // Has "phone" + "slim"!
  
  // Electronics
  { id: 'E001', title: 'Wireless Phone Charger Stand', category: 'electronics', price: 25.99, rating: 4.6, reviewCount: 890, attributes: ['wireless', 'charger', 'phone', 'stand'] },
  { id: 'E002', title: 'USB-C Phone Charging Cable 6ft', category: 'electronics', price: 12.99, rating: 4.4, reviewCount: 320, attributes: ['usb-c', 'charging', 'cable', 'phone'] },
  
  // More phone cases - lower reviews
  { id: 'P004', title: 'Rugged Phone Case Military Grade', category: 'phone-accessories', price: 34.99, rating: 4.6, reviewCount: 340, attributes: ['rugged', 'military', 'protective', 'drop-proof'] },
  { id: 'P005', title: 'Slim Phone Case Matte Finish', category: 'phone-accessories', price: 14.99, rating: 4.2, reviewCount: 290, attributes: ['slim', 'matte', 'lightweight', 'minimal', 'phone', 'case'] },
];

// The seller's product we want to find competitors for
const SELLER_PRODUCT: Product = {
  id: 'SELLER001',
  title: 'Ultra Slim Phone Case - Matte Black',
  category: 'phone-accessories',
  price: 17.99,
  rating: 4.3,
  reviewCount: 156,
  attributes: ['slim', 'matte', 'phone', 'case', 'protective']
};

// ============ PIPELINE STEPS ============

/**
 * Step 1: Generate search keywords from product (simulated LLM)
 * BUG: The keyword extraction is too broad - it extracts "phone" and "stand" 
 * separately, which will match laptop stands
 */
async function generateKeywords(product: Product): Promise<string[]> {
  // Simulate LLM keyword extraction
  // BUG: Extracts individual words without understanding product type
  const titleWords = product.title.toLowerCase().split(/\s+/);
  const keywords = [...new Set([...titleWords, ...product.attributes])];
  
  // This is the bug: "phone" as a standalone keyword matches laptop stands with phone holders
  return keywords.filter(k => k.length > 2);
}

/**
 * Step 2: Retrieve candidates matching keywords
 */
async function retrieveCandidates(keywords: string[], excludeId: string): Promise<Product[]> {
  return PRODUCT_CATALOG.filter(p => {
    if (p.id === excludeId) return false;
    const productText = `${p.title} ${p.attributes.join(' ')}`.toLowerCase();
    return keywords.some(k => productText.includes(k));
  });
}

/**
 * Step 3: Filter by price range and minimum rating
 * BUG: Price filter is too loose (3x range instead of 2x)
 */
async function filterCandidates(candidates: Product[], referencePrice: number): Promise<FilterResult> {
  const minPrice = referencePrice * 0.3; // Too loose!
  const maxPrice = referencePrice * 3.0; // Too loose!
  const minRating = 4.0;
  
  const passed: Product[] = [];
  const rejected: Array<{ product: Product; reason: string }> = [];
  
  for (const p of candidates) {
    if (p.price < minPrice) {
      rejected.push({ product: p, reason: `price_too_low: ${p.price} < ${minPrice}` });
    } else if (p.price > maxPrice) {
      rejected.push({ product: p, reason: `price_too_high: ${p.price} > ${maxPrice}` });
    } else if (p.rating < minRating) {
      rejected.push({ product: p, reason: `rating_too_low: ${p.rating} < ${minRating}` });
    } else {
      passed.push(p);
    }
  }
  
  return { passed, rejected };
}

/**
 * Step 4: Rank by relevance
 * BUG: Ranking heavily weights reviews, which favors laptop stands with more reviews
 */
async function rankCandidates(candidates: Product[], keywords: string[], referenceProduct: Product): Promise<ScoredProduct[]> {
  return candidates.map(p => {
    const productText = `${p.title} ${p.attributes.join(' ')}`.toLowerCase();
    const matchedKeywords = keywords.filter(k => productText.includes(k));
    
    // BUG: Review count weighted too heavily - laptop stands have more reviews!
    const keywordScore = matchedKeywords.length / keywords.length;
    const ratingBonus = p.rating / 5;
    const reviewBonus = Math.min(p.reviewCount / 500, 1); // BUG: Normalized to 500, not 1000
    
    // Category match should be weighted heavily but isn't!
    const categoryMatch = p.category === referenceProduct.category ? 0.05 : 0; // BUG: Only 5%!
    
    // BUG: Reviews weighted at 40%, category at 5%
    const relevanceScore = (keywordScore * 0.35) + (ratingBonus * 0.2) + (reviewBonus * 0.4) + categoryMatch;
    
    return {
      ...p,
      relevanceScore,
      matchReasons: matchedKeywords
    };
  }).sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Step 5: Select best match
 */
async function selectBest(ranked: ScoredProduct[]): Promise<ScoredProduct | null> {
  return ranked[0] || null;
}

// ============ MAIN PIPELINE ============

async function competitorSelectionPipeline(sellerProduct: Product): Promise<ScoredProduct | null> {
  return await xray.run(
    'competitor-selection',
    'v1.0.0',
    async () => {
      // Step 1: Generate keywords
      const keywords = await xray.step(
        StepType.GENERATION,
        'keyword-extraction',
        async () => generateKeywords(sellerProduct),
        {
          captureLevel: CaptureLevel.FULL,
          artifacts: {
            model: 'keyword-extractor-v1',
            input_title: sellerProduct.title,
            input_category: sellerProduct.category,
            reasoning: 'Extracted keywords from title and attributes'
          }
        }
      );

      console.log('Generated keywords:', keywords);

      // Step 2: Retrieve candidates
      const candidates = await xray.step(
        StepType.RETRIEVAL,
        'candidate-retrieval',
        async () => retrieveCandidates(keywords, sellerProduct.id),
        {
          captureLevel: CaptureLevel.SUMMARY,
          artifacts: {
            search_keywords: keywords,
            catalog_size: PRODUCT_CATALOG.length,
            excluded_id: sellerProduct.id
          }
        }
      );

      console.log(`Retrieved ${candidates.length} candidates`);

      // Step 3: Filter candidates
      const filterResult = await filterCandidates(candidates, sellerProduct.price);
      
      const filtered = await xray.step(
        StepType.FILTER,
        'price-rating-filter',
        async () => filterResult.passed,
        {
          captureLevel: CaptureLevel.FULL,
          candidates: candidates.map(c => ({
            candidateId: c.id,
            content: c,
            metadata: { price: c.price, rating: c.rating }
          })),
          artifacts: {
            reference_price: sellerProduct.price,
            price_range: { min: sellerProduct.price * 0.3, max: sellerProduct.price * 3.0 },
            min_rating: 4.0,
            rejected_reasons: filterResult.rejected.map(r => ({ id: r.product.id, reason: r.reason }))
          },
          metrics: {
            rejected_count: filterResult.rejected.length,
            passed_count: filterResult.passed.length
          }
        }
      );

      console.log(`Filtered to ${filtered.length} candidates (rejected ${filterResult.rejected.length})`);

      // Step 4: Rank candidates
      const rankedResult = await rankCandidates(filtered, keywords, sellerProduct);
      
      const ranked = await xray.step(
        StepType.RANKING,
        'relevance-ranking',
        async () => rankedResult,
        {
          captureLevel: CaptureLevel.FULL,
          candidates: filtered.map(c => ({
            candidateId: c.id,
            content: c,
            metadata: { category: c.category }
          })),
          artifacts: {
            ranking_method: 'weighted_keyword_overlap',
            weights: { keyword_match: 0.35, rating: 0.2, reviews: 0.4, category: 0.05 },
            reference_category: sellerProduct.category,
            top_scores: rankedResult.slice(0, 5).map(r => ({ id: r.id, score: r.relevanceScore, reasons: r.matchReasons }))
          }
        }
      );

      console.log('Top 3 ranked:');
      ranked.slice(0, 3).forEach((r: ScoredProduct, i: number) => {
        console.log(`  ${i + 1}. ${r.title} (score: ${r.relevanceScore.toFixed(3)}, category: ${r.category})`);
      });

      // Step 5: Select best
      const selected = await xray.step(
        StepType.SELECTION,
        'best-match-selection',
        async () => selectBest(ranked),
        {
          captureLevel: CaptureLevel.FULL,
          candidates: ranked.slice(0, 5).map((c: ScoredProduct) => ({
            candidateId: c.id,
            content: c,
            metadata: { score: c.relevanceScore, reasons: c.matchReasons }
          })),
          artifacts: {
            selection_method: 'top_score',
            selected_id: ranked[0]?.id,
            selected_score: ranked[0]?.relevanceScore,
            runner_up_id: ranked[1]?.id,
            runner_up_score: ranked[1]?.relevanceScore
          }
        }
      );

      return selected;
    },
    {
      environment: Environment.DEV,
      metadata: {
        seller_product_id: sellerProduct.id,
        seller_product_title: sellerProduct.title,
        trigger: 'manual_demo'
      }
    }
  );
}

// ============ RUN DEMO ============

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('X-Ray Competitor Selection Demo');
  console.log('='.repeat(60));
  console.log();
  console.log('Seller Product:', SELLER_PRODUCT.title);
  console.log('Category:', SELLER_PRODUCT.category);
  console.log('Price: $' + SELLER_PRODUCT.price);
  console.log();
  console.log('Running pipeline...');
  console.log('-'.repeat(60));

  try {
    const result = await competitorSelectionPipeline(SELLER_PRODUCT);

    console.log();
    console.log('='.repeat(60));
    console.log('RESULT');
    console.log('='.repeat(60));

    if (result) {
      console.log();
      console.log('Selected Competitor:', result.title);
      console.log('Category:', result.category);
      console.log('Price: $' + result.price);
      console.log('Relevance Score:', result.relevanceScore.toFixed(3));
      console.log('Match Reasons:', result.matchReasons.join(', '));
      console.log();

      // Check if this is a bad match
      if (result.category !== SELLER_PRODUCT.category) {
        console.log('⚠️  WARNING: Category mismatch!');
        console.log(`   Seller category: ${SELLER_PRODUCT.category}`);
        console.log(`   Selected category: ${result.category}`);
        console.log();
        console.log('This is the bug we want to debug with X-Ray!');
        console.log('Query the API to see what went wrong:');
        console.log();
        console.log('  curl http://localhost:4000/api/v1/runs | jq');
        console.log('  curl "http://localhost:4000/api/v1/analytics/high-drop-steps?min_drop_ratio=0.5" | jq');
      }
    } else {
      console.log('No competitor found!');
    }

    console.log();
    console.log('='.repeat(60));
    console.log('X-Ray data captured! Query the API to debug:');
    console.log('='.repeat(60));
    console.log();
    console.log('List all runs:');
    console.log('  curl http://localhost:4000/api/v1/runs | jq');
    console.log();
    console.log('Get run details (replace RUN_ID):');
    console.log('  curl http://localhost:4000/api/v1/runs/RUN_ID | jq');
    console.log();
    console.log('Find high-drop filter steps across all pipelines:');
    console.log('  curl "http://localhost:4000/api/v1/analytics/high-drop-steps?step_type=FILTER" | jq');
    console.log();

  } catch (error) {
    console.error('Pipeline failed:', error);
    console.log();
    console.log('Make sure the X-Ray server is running:');
    console.log('  npx ts-node server/index.ts');
  }
}

main();
