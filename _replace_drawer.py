#!/usr/bin/env python3
import sys

filepath = sys.argv[1]
with open(filepath, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Replace lines 990-1022 (0-indexed: 989-1021) with new content drawer + quiz wizard
start = 989
end = 1021

replacement_lines = """<!-- ── Content Drawer (add/edit video, quiz, or document) ── -->
<div class="mod-drawer-backdrop" id="vid-backdrop" onclick="closeVideoDrawer()"></div>
<div class="mod-drawer" id="vid-drawer">
  <div class="mod-drawer-hdr">
    <div class="mod-drawer-title" id="vid-drawer-title">Add Content</div>
    <button class="drawer-close" onclick="closeVideoDrawer()">✕</button>
  </div>
  <div class="mod-drawer-body">
    <input type="hidden" id="vid-id">
    <input type="hidden" id="vid-module-id">
    <div class="mod-dfg">
      <label>Content Type</label>
      <div class="content-type-selector" id="content-type-selector">
        <div class="ct-pill ct-active" data-type="video" onclick="selectContentType('video')">🎬 Video</div>
        <div class="ct-pill" data-type="quiz" onclick="selectContentType('quiz')">📝 Quiz</div>
        <div class="ct-pill" data-type="document" onclick="selectContentType('document')">📄 Document</div>
      </div>
    </div>
    <div class="mod-dfg">
      <label>Title</label>
      <input type="text" id="vid-title" placeholder="e.g. PMP Step 1 – Arrival &amp; Assessment">
    </div>
    <div class="mod-dfg" id="content-url-group">
      <label id="content-url-label">Google Drive Share URL</label>
      <input type="text" id="vid-url" placeholder="https://drive.google.com/file/d/…/view">
      <div class="hint" id="content-url-hint">Paste the Share link from Google Drive. Supports videos, PDFs, Google Docs, PPTX, Excel, and more.</div>
    </div>
    <div class="mod-dfg" id="quiz-builder-group" style="display:none">
      <label>Quiz Questions</label>
      <div id="quiz-summary" class="quiz-summary">No questions added yet.</div>
      <button class="tr-add-video-btn" style="margin-top:.5rem" onclick="openQuizWizard()">📝 Open Quiz Builder</button>
    </div>
    <div class="mod-dfg">
      <label>Description <span style="font-weight:400;color:var(--muted);font-size:.72rem">(optional)</span></label>
      <textarea id="vid-desc" rows="2" placeholder="What is covered in this content..."></textarea>
    </div>
    <div class="mod-dfg" id="content-gate-group">
      <label class="mod-gate-label">
        <input type="checkbox" id="content-pass-required" onchange="toggleThresholdVisibility()">
        <span>Must complete/pass to unlock next item</span>
      </label>
    </div>
    <div class="mod-dfg" id="content-threshold-group" style="display:none">
      <label>Pass Threshold <span style="font-weight:400;color:var(--muted);font-size:.72rem">(%)</span></label>
      <input type="number" id="content-pass-threshold" min="1" max="100" value="80" placeholder="80">
    </div>
    <div class="mod-dfg">
      <label>Display Order <span style="font-weight:400;color:var(--muted);font-size:.72rem">(lower = first)</span></label>
      <input type="number" id="vid-order" min="1" placeholder="1">
    </div>
    <div class="mod-drawer-msg" id="vid-drawer-msg"></div>
  </div>
  <div class="mod-drawer-foot">
    <button class="mod-save-btn" id="vid-save-btn" onclick="saveVideo()">Save Content</button>
  </div>
</div>

<!-- ── Quiz Wizard Overlay ── -->
<div class="quiz-wizard-overlay" id="quiz-wizard-overlay" style="display:none">
  <div class="quiz-wizard">
    <div class="qw-header">
      <div class="qw-title">Quiz Builder</div>
      <button class="drawer-close" onclick="closeQuizWizard()">✕</button>
    </div>
    <div class="qw-body" id="qw-body">
      <div class="qw-questions" id="qw-questions"></div>
      <button class="tr-add-video-btn" onclick="addQuizQuestion()" style="margin-top:1rem">+ Add Question</button>
    </div>
    <div class="qw-preview-toggle">
      <button class="mod-act-btn" onclick="toggleQuizPreview()" id="qw-preview-btn">👁 Preview Quiz</button>
    </div>
    <div class="qw-preview" id="qw-preview" style="display:none"></div>
    <div class="qw-footer">
      <button class="mod-save-btn" onclick="saveQuizFromWizard()">Done — Save Questions</button>
    </div>
  </div>
</div>
""".split('\n')

# Replace lines
new_lines = lines[:start] + [line + '\n' for line in replacement_lines] + lines[end+1:]

with open(filepath, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print(f'Done: replaced lines {start+1}-{end+1} with {len(replacement_lines)} new lines')
print(f'Total lines: {len(lines)} -> {len(new_lines)}')