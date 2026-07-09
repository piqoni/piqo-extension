# Piqo escape examples

## Active markers (will be processed)

@piqo add a table of contents here

Some text with a marker: @piqo summarize this section

## Escaped via inline code (will NOT be processed)

Use `@piqo` to mark instructions in your files.

Wrap the instruction in backticks: `@piqo do something`.

Double backtick variant: ``@piqo`` also works.

## Escaped via code fence (will NOT be processed)

```
@piqo this is inside a fenced block and will be ignored
```

~~~
@piqo tildes also work as fence delimiters
~~~

## Escaped via indentation (will NOT be processed)

    @piqo this is indented with 4 spaces

	@piqo this is indented with a tab

## Mixed

Line with `@piqo in code` but also @piqo outside code — only the second one triggers.
