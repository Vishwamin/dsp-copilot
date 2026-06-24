from langchain_community.document_loaders import PyMuPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import Chroma

import os

DOCS_PATH = "docs/data"

documents = []

files = os.listdir(DOCS_PATH)

print("\nFILES FOUND:\n")
print(files)

for file in files:

    if file.endswith(".pdf"):

        try:

            pdf_path = os.path.join(DOCS_PATH, file)

            print(f"\nLOADING PDF: {file}")

            loader = PyMuPDFLoader(pdf_path)

            docs = loader.load()

            print(f"PAGES LOADED: {len(docs)}")

            if len(docs) > 0:

                print("\nSAMPLE TEXT:\n")

                print(docs[0].page_content[:500])

                documents.extend(docs)

        except Exception as e:

            print(f"\nERROR LOADING {file}")
            print(e)

print(f"\nTOTAL DOCUMENTS: {len(documents)}")

if len(documents) == 0:

    print("\nNO DOCUMENTS LOADED")
    exit()

text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=100
)

texts = text_splitter.split_documents(documents)

print(f"\nTOTAL CHUNKS: {len(texts)}")

embeddings = HuggingFaceEmbeddings(
    model_name="sentence-transformers/all-mpnet-base-v2"
)

print("\nCREATING CHROMADB...\n")

db = Chroma.from_documents(
    texts,
    embeddings,
    persist_directory="db"
)

print("\nDSP KNOWLEDGE BASE CREATED SUCCESSFULLY!")