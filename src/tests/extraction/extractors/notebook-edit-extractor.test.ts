import { extractNotebookEdit } from '../../../extraction/extractors/notebook-edit.js';

describe('extractNotebookEdit', () => {
  it('title includes cell/change info', () => {
    const result = extractNotebookEdit(
      { cell_id: 'cell-3', type: 'modify', notebook: '/nb.ipynb' },
      { content: 'print("hello")' }
    );
    expect(result).not.toBeNull();
    expect(result!.title).toContain('NotebookEdit: cell-3');
  });

  it('files_modified includes notebook path', () => {
    const result = extractNotebookEdit(
      { cell_id: 'cell-1', notebook: '/data/analysis.ipynb' },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!.files_modified).toEqual(['/data/analysis.ipynb']);
  });

  it('returns null when no cell/change identifier', () => {
    expect(extractNotebookEdit({}, undefined)).toBeNull();
  });
});
