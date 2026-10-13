/**
 * Hand-labelled query pairs for judging the semantic cache.
 *
 * PARAPHRASES  the same question in different words. A correct cache SHOULD
 *              serve one from the other. Several share almost no vocabulary,
 *              which is what separates a semantic cache from string matching.
 * DIFFERENT    questions that must NOT share an answer. The hard ones keep the
 *              sentence and swap the subject ("France" -> "Germany"), which is
 *              exactly where a loose threshold serves wrong answers.
 *
 * Used by test/semanticMinilm.test.ts and bench/thresholdSweep.ts.
 */
export const PARAPHRASES: [string, string][] = [
  ["What is the capital of France?", "Which city is the capital of France?"],
  ["What is the capital of France?", "Tell me France's capital city"],
  ["How do I reset my password?", "I forgot my password, how can I recover it?"],
  ["How do I reverse a list in Python?", "Python: reverse the order of a list"],
  ["What are the symptoms of dehydration?", "How can I tell if I am dehydrated?"],
  ["How tall is Mount Everest?", "What is the height of Mount Everest?"],
  ["Who wrote Pride and Prejudice?", "Pride and Prejudice was written by whom?"],
  ["How do I cancel my subscription?", "I want to stop my subscription, what do I do?"],
  ["What time zone is Tokyo in?", "Which timezone does Tokyo use?"],
  ["How many days are in a leap year?", "Number of days in a leap year"],
  ["Explain how a hash map works", "How does a hash table work internally?"],
  ["What is the boiling point of water?", "At what temperature does water boil?"],
  ["How do I convert Celsius to Fahrenheit?", "Formula to change Celsius into Fahrenheit"],
  ["What does HTTP 404 mean?", "What is a 404 error?"],
  ["Best way to learn guitar as a beginner", "How should a beginner start learning guitar?"],
  ["How do I make a cup of tea?", "Steps to brew a cup of tea"],
];

export const DIFFERENT: [string, string][] = [
  // Same template, different subject: the dangerous kind.
  ["What is the capital of France?", "What is the capital of Germany?"],
  ["How do I reverse a list in Python?", "How do I reverse a string in Java?"],
  ["How tall is Mount Everest?", "How tall is the Eiffel Tower?"],
  ["Who wrote Pride and Prejudice?", "Who wrote War and Peace?"],
  ["What time zone is Tokyo in?", "What time zone is London in?"],
  ["How do I reset my password?", "How do I delete my account?"],
  ["What is the boiling point of water?", "What is the freezing point of water?"],
  ["How do I convert Celsius to Fahrenheit?", "How do I convert kilometres to miles?"],
  ["What does HTTP 404 mean?", "What does HTTP 500 mean?"],
  // Unrelated.
  ["How do I make a cup of tea?", "What is the speed of light?"],
  ["Explain how a hash map works", "Who won the 2011 Cricket World Cup?"],
  ["Best way to learn guitar as a beginner", "How do vaccines train the immune system?"],
];
