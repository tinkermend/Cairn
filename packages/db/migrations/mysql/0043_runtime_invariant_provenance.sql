-- 0059 的 MySQL 等价增量：结果行 provenance 增补 runtime_invariant

ALTER TABLE outcome_results DROP CHECK outcome_results_provenance_check;

ALTER TABLE outcome_results
  ADD CONSTRAINT outcome_results_provenance_check CHECK (
    provenance IN (
      'manual',
      'module_inherited',
      'recorded',
      'ai_compiled',
      'legacy_assert',
      'runtime_invariant'
    )
  );
