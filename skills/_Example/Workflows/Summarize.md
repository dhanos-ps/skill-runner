# Summarize — Example Workflow

> Example workflow for skill-runner. Takes uploaded text files and produces a structured summary.

**Input files are in:** `{input_dir}`
**Output files go to:** `{output_dir}`

**Job params:**
```json
{ "topic": "meeting notes", "author": "Jane Smith" }
```

**Produces:**
- `{output_dir}/summary.md` — structured summary of the input files

---

## Step 1: Discover input files

Use `list_files` to see what was uploaded:

```
list_files(dir_path: "{input_dir}")
```

Report what files are available. If no files are found, stop and report: "No input files found."

---

## Step 2: Read each input file

For each file discovered in Step 1, read its contents:

```
read_file(file_path: "{input_dir}/{filename}")
```

Also run `word_count` on each file to get basic stats:

```
word_count(file_path: "{input_dir}/{filename}")
```

---

## Step 3: Analyze and summarize

Based on the content read in Step 2, produce a structured summary with:

1. **Overview** — 2-3 sentence high-level summary
2. **Key Points** — bulleted list of the most important items
3. **Action Items** — any tasks, decisions, or follow-ups mentioned
4. **Statistics** — file count, total word count, key metrics

---

## Step 4: Write output

Write the summary to the output directory:

```
write_file(
  file_path: "summary.md",
  content: [the structured summary]
)
```

---

## Summary output

After all steps complete, output:

```
Summarize Complete — {topic}
----------------------------------------------
OK Discovery  -> {N} input files found
OK Analysis   -> {word_count} total words processed
OK Summary    -> summary.md written

Output files:
  {output_dir}/summary.md
```
