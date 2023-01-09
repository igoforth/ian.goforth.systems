---
layout: "../../layouts/BlogPost.astro"
title: "My Thoughts on Assembly"
description: "My guidelines on writing x86_64 NASM and a reading list."
pubDate: "Jan 8 2023"
heroImage: "/rmRadev-Early-Morning.jpg"
---

## Prologue

With the universal applicability of C, writing assembly has become a specialized skill in most situations. While assembly can be necessary in certain cases, it is usually not a software engineer's first choice. For tasks like prototyping, data science, or rapid turnaround, higher level languages like Python would be more suitable.

The abstractions provided by higher level languages allow us to create complex programs more quickly. Most compilers convert these abstractions into machine code, often producing results that are difficult or impossible for a programmer to achieve manually. However, a compiler does not understand the intent behind the code – it simply follows its rules and syntax.

Assembly offers flexibility through its use of code spacing, labels, and effective addressing. It is also specific to each processor and its instruction set architecture. Assembly can also be optimized to produce more efficient and specific code than a compiler can generate.

The potential for <u>badly written assembly</u> is a big problem. Assemblers are much more syntactically lenient than compilers. The lack of abstractions means that responsible commenting and clear structure is essential. Coupled with assembly's low popularity and thus online resources, it has been a challenge to find the "correct" way to do things.

## Personal Experience

I don't have much experience with assembly, and I know that is true for many others as well. In higher education, assembly is often only taught as part of classes focused on Operating Systems theory. While this is understandable, it is not enough to grasp the intricacies of different ABIs and ISA implementations. As a result, these topics often become milestones for aspiring professionals.

I am currently working on an assembly project – a simple web server written in x86_64 NASM. While it is not yet complete, I have made significant progress and expect to finish within the week. Working on this project has been a great learning opportunity, and I have gained valuable insights as I have progressed. Once the project is finished, I plan to write a detailed blog post about what it does and how I designed it. You can find the repository for the project [here](https://github.com/igoforth/asmserv). 

### Best Practices
In my research, I have developed personal guidelines for coding in x86_64 NASM Assembly.
1. I have adopted a source code format that follows the [example](https://www.nasm.us/doc/nasmdoc3.html#section-3.1) in the NASM manual. This is the 4-column approach, which is reminiscent of how older programs were structured using punch cards.

```nasm
label:    instruction operands        ; comment
```

2. I have taken some liberties with source code summaries and descriptions of subroutines and functions:
```nasm
; -----------------------------------------
; <Program description>
; <Author>
; 
; <Source code description>
; -----------------------------------------
```
```nasm
function: ; function description
; register: parameter and/or purpose
; register: parameter and/or purpose

; section description
```
3. For important, large, or entry functions, I prepend an underscore "_". While this is traditionally used to indicate that the function is designed to interoperate with C and the gcc compiler, it helps me to distinguish which functions are meant to be referenced externally and which are just subroutines.
4. Whether I include a [prologue or epilogue](https://en.wikipedia.org/wiki/Function_prologue_and_epilogue) in a callee depends on several factors:
    1. Is the callee a [function or a subroutine](https://en.wikipedia.org/wiki/Function_(computer_programming)#Terminology)?
    2. Is the callee large enough to justify its own stack frame?
    3. Does the callee use enough registers that caller registers must be pushed to the stack?
    4. Does the callee need to use local variables that are stored in the caller?
    5. Does the caller need to use variables local to the callee?
 It is important to note that while a prologue/epilogue isn't expensive, I shouldn't include one if I don't have to. 
5. In cases where a function needs to act on caller data or vice versa, we can allocate space in .data and either return a pointer or externally reference it.

### Reading List
I have a reading list too. Most of these were added to either grasp the specifics of an implementation or improve my general programming capabilities.
1. [Intel x86 SDM](https://cdrdv2.intel.com/v1/dl/getContent/671200)
2. [System V x86-64 ABI](https://gitlab.com/x86-psABIs/x86-64-ABI)
3. [Agner Fog's Microarchitecture Manual](https://www.agner.org/optimize/microarchitecture.pdf)
4. [What Every Programmer Should Know About Memory](https://www.akkadia.org/drepper/cpumemory.pdf)
5. [MS x64 Conventions](https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention?view=msvc-170)
6. RISC-V ISM [Volume 1](https://github.com/riscv/riscv-isa-manual/releases/download/Ratified-IMAFDQC/riscv-spec-20191213.pdf) [Volume 2](https://github.com/riscv/riscv-isa-manual/releases/download/Priv-v1.12/riscv-privileged-20211203.pdf)

## Epilogue

There are doubtlessly peculiarities about how I write assembly. I'm self-taught and could have picked up bad practices leading to <u>badly written assembly</u>. I open myself to the judgement of my more experienced peers. Please contact me if you notice something! I plan to continue learning and experimenting with assembly in future projects. I hope that sharing my experiences and the practices I've developed so far can be helpful to others on the same journey.

Image by [rmRadev](https://www.deviantart.com/rmradev/art/Early-morning-934367339).