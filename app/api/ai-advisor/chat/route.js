// app/api/ai-advisor/chat/route.js

// Standard imports
import { textModel } from "../../../lib/gemini"; // Gemini AI instance
import connectDB from "../../../lib/mongodb";
import Pet from "../../../models/PetModel";

// --- SECURITY PLACEHOLDER ---
// In a real application, this function securely extracts the authenticated user ID (e.g., from session, JWT, or NextAuth context).
async function getAuthenticatedUserId(req) {
    // Placeholder implementation: In a real Next.js API route, this might involve calling auth() or reading a secure cookie/header.
    // For this fix, we assume a utility provides a valid user ID string if authenticated, or null/undefined otherwise.
    // Replace with your actual authentication logic.
    return "exampleUserId123"; // MOCK USER ID
}
// ----------------------------

/**
 * Fetches pet details. Restricts sensitive information (medical history, full vaccination records) 
 * if the requesting user is not the owner of the pet.
 * @param {string} petId - The ID of the pet to fetch.
 * @param {string} requestingUserId - The ID of the currently authenticated user.
 * @returns {object|null} The filtered pet details.
 */
async function getPetDetails(petId, requestingUserId) {
  const pet = await Pet.findById(petId).lean();
  if (!pet) return null;

  // Crucial Authorization Check: Determine if the requesting user owns this pet
  // Assumes PetModel stores ownerId as a MongoDB ObjectId
  const isOwner = pet.ownerId && pet.ownerId.toString() === requestingUserId;

  // Handle missing lineage names
  const sireInfo = pet.sireName || (pet.sireId ? "Registered (Name hidden)" : "Unknown");
  const damInfo = pet.damName || (pet.damId ? "Registered (Name hidden)" : "Unknown");

  let petDetails = {
    // Public Data
    _id: pet._id,
    name: pet.name,
    type: pet.type,
    breed: pet.breed,
    age: pet.age,
    // Lineage Info (kept basic/restricted if IDs are present but names hidden)
    lineageInfo: `Sire: ${sireInfo}, Dam: ${damInfo}`
  };

  // SECURITY FIX: Only expose sensitive data if the user is authorized (the owner).
  if (isOwner) {
    petDetails.medicalHistoryLog = pet.medicalHistoryLog;
    petDetails.vaccinationHistory = pet.vaccinationHistory;
  } else {
    // Provide non-specific/restricted data substitutes to the AI prompt
    petDetails.medicalHistoryLog = "Access Restricted: Medical history not shared by the owner.";
    petDetails.vaccinationHistory = []; // Ensure this is empty to trigger restricted formatting
  }
  
  return petDetails;
}

// POST request handler
export async function POST(req) {
  try {
    await connectDB();
    
    // --- SECURITY FIX: AUTHORIZATION CHECK ---
    const requestingUserId = await getAuthenticatedUserId(req);
    if (!requestingUserId) {
      return new Response(JSON.stringify({ error: "Authentication Required" }), { status: 401 });
    }
    // -----------------------------------------

    // Parse request body
    const { petAId, petBId, history, message } = await req.json();

    if (!petAId || !petBId) return new Response(JSON.stringify({ error: "IDs required" }), { status: 400 });

    // Fetch pet profiles, passing the user ID to apply authorization filtering
    const petA = await getPetDetails(petAId, requestingUserId); // User's Pet (Should be owned by requestingUserId)
    const petB = await getPetDetails(petBId, requestingUserId); // Target Pet (Data filtered based on ownership)

    if (!petA || !petB) return new Response(JSON.stringify({ error: "Pets not found" }), { status: 404 });

    // Format vaccination list (Handles empty/restricted array from getPetDetails)
    const vaxList = petB.vaccinationHistory && petB.vaccinationHistory.length > 0
        ? petB.vaccinationHistory.map(v => `- ${v.vaccineName} (Expires: ${new Date(v.expiryDate).toLocaleDateString()})`).join("\n")
        : "Records Restricted or Not Visible.";
        
    const petBMedicalHistory = petB.medicalHistoryLog || "No specific medical issues recorded.";

    // Define AI instructions
    const systemPrompt = `
      You are an expert Pet Advisor and Geneticist.
      The user (owner of Pet A) is asking about Pet B (the target pet).

      **TARGET PET (PET B) DETAILS:**
      - Name: ${petB.name}
      - Species: ${petB.type}
      - Breed: ${petB.breed}
      - Age: ${petB.age}
      - Lineage: ${petB.lineageInfo}
      
      **MEDICAL HISTORY LOG (From Dr. Paws):**
      """
      ${petBMedicalHistory}
      """

      **VACCINATION STATUS:**
      ${vaxList}

      **USER'S PET (PET A - For Compatibility Context):**
      - Name: ${petA.name}
      - Breed: ${petA.breed}
      - Species: ${petA.type}

      **INSTRUCTIONS:**
      1. Answer questions specifically about Pet B's health, history, or traits using the data above.
      2. If the user asks about "medical details", "surgery", or "illness", YOU MUST summarize the "MEDICAL HISTORY LOG" provided above.
      3. If the log states "Access Restricted: Medical history not shared by the owner.", inform the user that this specific information is not available due to privacy settings. Do NOT elaborate or reveal specifics.
      4. If the log is empty/default, state that no history is available.
      5. If asked about offspring, analyze compatibility based on Breed/Species.
    `;

    // Initialize chat history
    const chat = textModel.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: `I have reviewed ${petB.name}'s profile, including available medical and vaccination information. What would you like to know?` }] },
        ...history // Add user history
      ]
    });

    // Get AI response
    const result = await chat.sendMessage(message);
    const responseText = result.response.text();

    return new Response(JSON.stringify({ text: responseText }), { status: 200 });

  } catch (err) {
    console.error("Advisor Error:", err);
    return new Response(JSON.stringify({ error: "Failed to generate advice" }), { status: 500 });
  }
}
```