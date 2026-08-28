// Where the original app's config loader used to be.
//
// The route asks this for one thing: where the Python interpreter and the model
// file for automatic background removal live. The original read that out of a
// config file; here it comes from the environment, which is what somebody
// running this from a terminal actually has.
//
// The route reads GIFLAB_PYTHON / _MODEL / _ALSO_MODELS directly and those
// still work untouched — they are checked BEFORE this file is consulted. What
// this adds is the GIFLAB_ spelling, because nobody installing a standalone tool
// should have to know the name of the app it came out of.
//
// Note the snake_case on also_models: that is the shape the route destructures,
// so it is the shape this returns.

export interface CutoutIntegration {
  python?: string;
  model?: string;
  also_models?: string[];
}

export interface Config {
  integrations?: { cutout?: CutoutIntegration };
}

export function getConfig(): Config {
  const also = process.env.GIFLAB_ALSO_MODELS || '';
  return {
    integrations: {
      cutout: {
        python: process.env.GIFLAB_PYTHON || '',
        model: process.env.GIFLAB_MODEL || '',
        also_models: also ? also.split(',').map((s) => s.trim()).filter(Boolean) : [],
      },
    },
  };
}
