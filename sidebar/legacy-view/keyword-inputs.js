// Captured controls stay private; reads occur at the original application stage.
export function createLegacyKeywordInputsView({document}) {
  function openBatchDraftInputs() {
    const links = document.getElementById("textareaBatchLinks");
    const bloggers = document.getElementById("textareaBatchBloggers");
    const keywords = document.getElementById("textareaBatchKeywords");
    return Object.freeze({
      read: () => Object.freeze({
        links: links?.value || "",
        bloggers: bloggers?.value || "",
        batchKeywordsText: keywords?.value || "",
      }),
      apply(draft) {
        if (links && links.value !== draft.links) links.value = draft.links;
        if (bloggers && bloggers.value !== draft.bloggers) bloggers.value = draft.bloggers;
        if (keywords && keywords.value !== draft.batchKeywordsText) {
          keywords.value = draft.batchKeywordsText;
        }
      },
    });
  }
  return Object.freeze({openBatchDraftInputs});
}
