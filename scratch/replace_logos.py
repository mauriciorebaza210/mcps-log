import os

html_path = '/Users/mauriciorebaza/mcps-log/index.html'

with open(html_path, 'r') as f:
    lines = f.readlines()

# Line numbers from view_file are 1-indexed.
# Line 23 and Line 38 (1-indexed)
# These are lines[22] and lines[37] (0-indexed)

# I'll double check the content of these lines before replacing to be safe.
# We want to replace the <img> tags.

modified = False
for i in [22, 37]:
    if '<img src="data:image/png;base64,' in lines[i]:
        # Replace the entire line content between src="..."
        # Actually simpler to just replace the whole tag on that line if it's the only thing.
        # Line 23: <img src="data:image/png;base64,..." alt="MCPS">
        # Line 38: <img src="data:image/png;base64,..." alt="MCPS">
        
        start_idx = lines[i].find('<img ')
        end_idx = lines[i].find('>', start_idx) + 1
        if start_idx != -1 and end_idx != 0:
            indent = lines[i][:start_idx]
            lines[i] = indent + '<img src="/logo.png" alt="MCPS">\n'
            modified = True

if modified:
    with open(html_path, 'w') as f:
        f.writelines(lines)
    print("Successfully replaced base64 logos with /logo.png")
else:
    print("Base64 logos not found at expected lines.")
