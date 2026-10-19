export const searchMapping = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    refresh_interval: '1s',
    analysis: {
      filter: { title_prefix: { type: 'edge_ngram', min_gram: 2, max_gram: 20 } },
      analyzer: {
        folded: { tokenizer: 'standard', filter: ['lowercase', 'asciifolding'] },
        autocomplete: {
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding', 'title_prefix'],
        },
      },
    },
  },
  mappings: {
    dynamic: 'strict',
    _meta: { eventflowSearchSchema: 1 },
    properties: {
      id: { type: 'keyword' },
      visible: { type: 'boolean' },
      version: { type: 'long' },
      sourceHash: { type: 'keyword', index: false },
      indexedAt: { type: 'date' },
      title: {
        type: 'text',
        analyzer: 'folded',
        fields: {
          stemmed: { type: 'text', analyzer: 'russian' },
          prefix: { type: 'text', analyzer: 'autocomplete', search_analyzer: 'folded' },
        },
      },
      description: {
        type: 'text',
        analyzer: 'folded',
        fields: { stemmed: { type: 'text', analyzer: 'russian' } },
      },
      city: { type: 'keyword' },
      cityKey: { type: 'keyword' },
      address: { type: 'text', index: false },
      timeZone: { type: 'keyword', index: false },
      startsAt: { type: 'date' },
      endsAt: { type: 'date' },
      localDate: { type: 'date', format: 'strict_date' },
      minPriceMinor: { type: 'integer' },
      currency: { type: 'keyword' },
      capacity: { type: 'integer' },
      coverId: { type: 'keyword', index: false },
    },
  },
};
